//! Jira webhook authentication and payload parsing (pure, no HTTP).

use guard_core::ports::{TrackerEvent, TrackerWebhookError, WebhookRequest};
use guard_tracker::webhook::{
    JiraWebhookEvent, authenticate, parse_payload, to_event, to_event_starting_on,
};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn request(auth: Option<&str>, query: Option<&str>) -> WebhookRequest {
    let mut req = WebhookRequest {
        query: query.map(Into::into),
        ..WebhookRequest::default()
    };
    if let Some(a) = auth {
        req.headers.insert("authorization".into(), a.into());
    }
    req
}

#[test]
fn bearer_header_or_secret_query_authenticates() {
    assert!(authenticate(&request(Some("Bearer s3cret"), None), Some("s3cret")).is_ok());
    assert!(authenticate(&request(Some("bearer s3cret"), None), Some("s3cret")).is_ok());
    assert!(authenticate(&request(None, Some("secret=s3cret")), Some("s3cret")).is_ok());
    // Percent-encoded query values are decoded.
    assert!(authenticate(&request(None, Some("x=1&secret=a%2Bb%20c")), Some("a+b c")).is_ok());
}

#[test]
fn wrong_missing_or_unconfigured_secret_is_unauthorized() {
    for (req, secret) in [
        (request(Some("Bearer nope"), None), Some("s3cret")),
        (request(Some("Basic s3cret"), None), Some("s3cret")),
        (request(None, Some("secret=nope")), Some("s3cret")),
        (request(None, Some("secret=")), Some("s3cret")),
        (request(None, None), Some("s3cret")),
        // No secret configured: fail closed, even with a header.
        (request(Some("Bearer s3cret"), None), None),
        (request(Some("Bearer "), None), Some("")),
    ] {
        assert_eq!(
            authenticate(&req, secret),
            Err(TrackerWebhookError::Unauthorized)
        );
    }
}

#[test]
fn issue_created_carries_the_ticket_with_wiki_description_and_string_criteria() {
    let hook = parse_payload(
        &fixture("webhook_issue_created.json"),
        Some("customfield_10050"),
    )
    .unwrap();
    assert_eq!(hook.event, JiraWebhookEvent::IssueCreated);
    assert_eq!(
        hook.actor_account_id.as_deref(),
        Some("557058:human-reporter")
    );
    let t = hook.ticket.unwrap();
    assert_eq!(t.key, "SHOP-7");
    assert_eq!(t.summary, "Show 'Sold out' badge on products without stock");
    assert_eq!(t.issue_type.as_deref(), Some("Story"));
    assert_eq!(t.labels, vec!["catalog"]);
    assert!(
        t.description
            .starts_with("Products with zero stock look buyable.")
    );
    assert_eq!(
        t.acceptance_criteria,
        vec![
            "A product with 0 available units shows 'Sold out'",
            "The add-to-cart button is disabled"
        ]
    );
}

#[test]
fn without_a_criteria_field_the_criteria_are_left_to_triage() {
    let hook = parse_payload(&fixture("webhook_issue_created.json"), None).unwrap();
    assert!(hook.ticket.unwrap().acceptance_criteria.is_empty());
}

#[test]
fn issue_updated_with_adf_description_and_adf_criteria() {
    let hook = parse_payload(
        &fixture("webhook_issue_updated_labels.json"),
        Some("customfield_10050"),
    )
    .unwrap();
    assert_eq!(hook.event, JiraWebhookEvent::IssueUpdated);
    assert!(hook.labels_changed);
    let t = hook.ticket.unwrap();
    assert_eq!(t.description, "Products with zero stock look buyable.");
    assert_eq!(
        t.acceptance_criteria,
        vec!["A product with 0 available units shows 'Sold out'"]
    );
}

#[test]
fn array_criteria_field_is_one_item_per_entry() {
    let body = br#"{"webhookEvent":"jira:issue_created","issue":{"key":"SHOP-8","fields":{
        "summary":"s","customfield_1":["  one ", "", "two"]}}}"#;
    let t = parse_payload(body, Some("customfield_1"))
        .unwrap()
        .ticket
        .unwrap();
    assert_eq!(t.acceptance_criteria, vec!["one", "two"]);
    assert_eq!(t.description, "");
}

#[test]
fn malformed_payloads() {
    for body in [
        &b"not json"[..],
        br#"{"issue": {"key": "SHOP-1"}}"#,
        br#"{"webhookEvent": "jira:issue_created"}"#,
        br#"{"webhookEvent": "jira:issue_created", "issue": {"fields": {}}}"#,
    ] {
        assert!(
            matches!(
                parse_payload(body, None),
                Err(TrackerWebhookError::Malformed(_))
            ),
            "{}",
            String::from_utf8_lossy(body)
        );
    }
}

#[test]
fn events_map_to_tracker_events() {
    let created = parse_payload(&fixture("webhook_issue_created.json"), None).unwrap();
    assert_eq!(
        to_event(&created, Some("bot")),
        TrackerEvent::IssueCreated {
            key: "SHOP-7".into()
        }
    );
    // Issue creation does not depend on knowing guard's own account.
    assert_eq!(
        to_event(&created, None),
        TrackerEvent::IssueCreated {
            key: "SHOP-7".into()
        }
    );

    let labels = parse_payload(&fixture("webhook_issue_updated_labels.json"), None).unwrap();
    assert_eq!(
        to_event(&labels, Some("bot")),
        TrackerEvent::LabelsChanged {
            key: "SHOP-7".into(),
            labels: vec![
                "area:catalog".into(),
                "catalog".into(),
                "lane:agent".into(),
                "type:minor_feature".into()
            ]
        }
    );
    // guard's own label writes never become human labels.
    assert!(matches!(
        to_event(&labels, Some("557058:human-reporter")),
        TrackerEvent::Ignored { .. }
    ));
    // Unknown own account: fail closed (cannot tell guard's writes apart).
    assert!(matches!(
        to_event(&labels, None),
        TrackerEvent::Ignored { .. }
    ));

    let summary = parse_payload(&fixture("webhook_issue_updated_summary.json"), None).unwrap();
    assert!(!summary.labels_changed);
    assert!(matches!(
        to_event(&summary, Some("bot")),
        TrackerEvent::Ignored { .. }
    ));

    let comment = parse_payload(&fixture("webhook_comment_created.json"), None).unwrap();
    assert_eq!(
        comment.event,
        JiraWebhookEvent::Other("comment_created".into())
    );
    match to_event(&comment, Some("bot")) {
        TrackerEvent::Ignored { reason } => assert!(reason.contains("comment_created")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn labels_fall_back_to_the_changelog_when_the_issue_has_none() {
    let body = br#"{"webhookEvent":"jira:issue_updated","user":{"accountId":"h"},
        "issue":{"key":"SHOP-9","fields":{"summary":"s"}},
        "changelog":{"items":[{"field":"labels","toString":"b a  a"}]}}"#;
    let hook = parse_payload(body, None).unwrap();
    assert_eq!(
        to_event(&hook, Some("bot")),
        TrackerEvent::LabelsChanged {
            key: "SHOP-9".into(),
            labels: vec!["a".into(), "b".into()]
        }
    );
}

#[test]
fn only_label_families_the_human_changed_are_reported() {
    // Active mode: guard wrote area/lane/type; the human only moved the area.
    let body = br#"{"webhookEvent":"jira:issue_updated","user":{"accountId":"h"},
        "issue":{"key":"SHOP-9","fields":{"summary":"s",
          "labels":["area:checkout","lane:agent","type:minor_feature","ux"]}},
        "changelog":{"items":[{"field":"labels",
          "fromString":"area:catalog lane:agent type:minor_feature ux",
          "toString":"area:checkout lane:agent type:minor_feature ux"}]}}"#;
    let hook = parse_payload(body, None).unwrap();
    assert_eq!(
        to_event(&hook, Some("bot")),
        TrackerEvent::LabelsChanged {
            key: "SHOP-9".into(),
            labels: vec!["area:checkout".into(), "ux".into()]
        }
    );

    // The human overrides the lane: the lane family counts.
    let body = br#"{"webhookEvent":"jira:issue_updated","user":{"accountId":"h"},
        "issue":{"key":"SHOP-9","fields":{"summary":"s",
          "labels":["area:catalog","lane:human","type:minor_feature"]}},
        "changelog":{"items":[{"field":"labels",
          "fromString":"area:catalog lane:agent type:minor_feature",
          "toString":"area:catalog lane:human type:minor_feature"}]}}"#;
    let hook = parse_payload(body, None).unwrap();
    assert_eq!(
        to_event(&hook, Some("bot")),
        TrackerEvent::LabelsChanged {
            key: "SHOP-9".into(),
            labels: vec!["lane:human".into()]
        }
    );

    // No changelog strings: nothing proves a family changed (fail closed).
    let body = br#"{"webhookEvent":"jira:issue_updated","user":{"accountId":"h"},
        "issue":{"key":"SHOP-9","fields":{"summary":"s","labels":["lane:agent","ux"]}},
        "changelog":{"items":[{"field":"labels"}]}}"#;
    let hook = parse_payload(body, None).unwrap();
    assert_eq!(
        to_event(&hook, Some("bot")),
        TrackerEvent::LabelsChanged {
            key: "SHOP-9".into(),
            labels: vec!["ux".into()]
        }
    );
}

// ------------------------------------------------------- start statuses
//
// `webhook_issue_updated_status.json` follows the changelog item Jira Cloud
// documents for a status change (`field`/`fieldId` `status`, `from`/`to` ids,
// `fromString`/`toString` names). It was written from that documented format,
// not recorded from a live site.

fn start_statuses(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| n.to_string()).collect()
}

fn status_changed(status: &str, change_id: Option<&str>) -> TrackerEvent {
    TrackerEvent::StatusChanged {
        key: "SHOP-7".into(),
        status: status.into(),
        change_id: change_id.map(Into::into),
    }
}

#[test]
fn a_move_to_a_start_status_maps_to_status_changed() {
    let hook = parse_payload(&fixture("webhook_issue_updated_status.json"), None).unwrap();
    assert_eq!(hook.status_changed_to.as_deref(), Some("In Development"));
    assert_eq!(hook.change_id.as_deref(), Some("10402"));
    assert!(!hook.labels_changed);
    let ticket = hook.ticket.as_ref().unwrap();
    assert_eq!(ticket.status.as_deref(), Some("In Development"));

    // Status names are compared case-insensitively.
    for listed in ["In Development", "in development", " IN DEVELOPMENT "] {
        assert_eq!(
            to_event_starting_on(&hook, Some("bot"), &start_statuses(&["Ready", listed])),
            status_changed("In Development", Some("10402")),
            "{listed:?}"
        );
    }

    // A changelog that also changes labels still starts the triage.
    let body = br#"{"webhookEvent":"jira:issue_updated","user":{"accountId":"h"},
        "issue":{"key":"SHOP-7","fields":{"summary":"s","labels":["ux"]}},
        "changelog":{"id":10403,"items":[
          {"field":"labels","fromString":"","toString":"ux"},
          {"field":"status","fromString":"To Do","toString":"In Development"}]}}"#;
    let both = parse_payload(body, None).unwrap();
    assert_eq!(
        to_event_starting_on(&both, Some("bot"), &start_statuses(&["In Development"])),
        status_changed("In Development", Some("10403"))
    );
}

#[test]
fn a_status_change_by_guard_or_with_an_unknown_account_is_ignored() {
    let hook = parse_payload(&fixture("webhook_issue_updated_status.json"), None).unwrap();
    let listed = start_statuses(&["In Development"]);
    match to_event_starting_on(&hook, Some("557058:human-reporter"), &listed) {
        TrackerEvent::Ignored { reason } => {
            assert_eq!(reason, "status change made by guard's own Jira user")
        }
        other => panic!("{other:?}"),
    }
    // Unknown own account: fail closed (guard's own moves cannot be told apart).
    match to_event_starting_on(&hook, None, &listed) {
        TrackerEvent::Ignored { reason } => {
            assert_eq!(reason, "guard's own Jira account id is not loaded")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn without_a_listed_status_issue_updated_maps_as_before() {
    let unchanged = "issue updated without a labels change";
    let ignored = |event: TrackerEvent| match event {
        TrackerEvent::Ignored { reason } => reason,
        other => panic!("{other:?}"),
    };
    let status = parse_payload(&fixture("webhook_issue_updated_status.json"), None).unwrap();
    // The feature is off: no list, or an empty one.
    assert_eq!(ignored(to_event(&status, Some("bot"))), unchanged);
    assert_eq!(
        ignored(to_event_starting_on(&status, Some("bot"), &[])),
        unchanged
    );
    // The feature is on, but the issue moved to another status.
    let listed = start_statuses(&["Ready for Dev"]);
    assert_eq!(
        ignored(to_event_starting_on(&status, Some("bot"), &listed)),
        unchanged
    );

    // Neither labels nor a status: ignored with the same reason.
    let listed = start_statuses(&["In Development"]);
    let summary = parse_payload(&fixture("webhook_issue_updated_summary.json"), None).unwrap();
    assert_eq!(summary.status_changed_to, None);
    assert_eq!(
        ignored(to_event_starting_on(&summary, Some("bot"), &listed)),
        unchanged
    );

    // Label changes keep recording the human label, whoever lists statuses.
    let labels = parse_payload(&fixture("webhook_issue_updated_labels.json"), None).unwrap();
    assert_eq!(
        to_event_starting_on(&labels, Some("bot"), &listed),
        to_event(&labels, Some("bot"))
    );
    assert!(matches!(
        to_event(&labels, Some("bot")),
        TrackerEvent::LabelsChanged { .. }
    ));
    assert_eq!(
        ignored(to_event_starting_on(
            &labels,
            Some("557058:human-reporter"),
            &listed
        )),
        "label change made by guard's own Jira user"
    );
}
