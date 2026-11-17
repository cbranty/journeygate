//! `[tracker].start_statuses`: a Jira issue moved to a listed status is
//! triaged, with or without a decision engine. Every test drives
//! `POST /webhooks/jira` and checks what the delivery left behind.

mod common;

use axum::http::StatusCode;
use common::*;
use guard_core::ports::fakes::{FakeDecisionEngine, FakeImpactAnalyzer, InMemoryTracker};
use guard_core::ports::*;
use guard_core::thresholds::Mode;
use guard_server::AppState;
use serde_json::json;
use std::sync::Arc;

const START: &str = "In Development";
const KEY: &str = "SHOP-7";

/// `jira:issue_updated` whose changelog moves `KEY` to `to`.
fn moved(to: &str, change_id: &str) -> serde_json::Value {
    json!({
        "webhookEvent": "jira:issue_updated",
        "issue": {"key": KEY},
        "changelog": {"id": change_id, "items": [
            {"field": "status", "fieldId": "status", "fromString": "To Do", "toString": to}
        ]}
    })
}

/// Fakes whose tracker and `target.toml` both list `START`.
fn starting(engine: FakeDecisionEngine) -> Fakes {
    starting_with(engine, FakeImpactAnalyzer::new())
}

fn starting_with(engine: FakeDecisionEngine, impact: FakeImpactAnalyzer) -> Fakes {
    Fakes {
        tracker: Arc::new(InMemoryTracker::new("SHOP").with_start_statuses(&[START])),
        impact: Arc::new(impact),
        ..Fakes::new(engine)
    }
}

fn state(fakes: &Fakes) -> AppState {
    let mut state = fakes.state();
    let tracker = state.config.tracker.as_mut().expect("[tracker] present");
    tracker.start_statuses = vec![START.to_string()];
    state
}

/// Seeds `KEY` already moved to `status`, as Jira has it when the webhook fires.
fn seed(fakes: &Fakes, summary: &str, status: &str, labels: &[&str]) {
    fakes.tracker.insert_issue(Issue {
        status: status.to_string(),
        status_category: StatusCategory::InProgress,
        ..issue(KEY, summary, "", labels)
    });
}

/// Delivers `body` and waits for the background processing.
async fn deliver(state: AppState, body: serde_json::Value) -> Response {
    let tasks = state.tasks.clone();
    let response = send(guard_server::router(state), jira_hook(body)).await;
    tasks.wait_idle().await;
    response
}

async fn decisions(fakes: &Fakes) -> Vec<TriageDecision> {
    fakes
        .store
        .list_for_calibration(&CalibrationQuery::default())
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.decision)
        .collect()
}

async fn only_decision(fakes: &Fakes) -> TriageDecision {
    let mut all = decisions(fakes).await;
    assert_eq!(all.len(), 1, "exactly one decision recorded");
    all.remove(0)
}

async fn labels(fakes: &Fakes) -> Vec<String> {
    fakes.tracker.get_issue(KEY).await.unwrap().labels
}

fn accepted() -> serde_json::Value {
    json!({"accepted": true, "event": "status_changed", "key": KEY})
}

// S3.2, S3.5 and S3.8: with an engine the decision is the `issue_created` one.
#[tokio::test]
async fn a_move_to_a_start_status_is_triaged_with_the_engine() {
    let fakes = starting(FakeDecisionEngine::new().with_triage(Ok(confident_answers("checkout"))));
    seed(&fakes, "Fix `web/src/checkout/cart.ts`", START, &[]);
    let (state, lane) = with_lane(active(state(&fakes)));

    // The status name is matched case-insensitively.
    let res = deliver(state, moved("in development", "10402")).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json(), accepted());

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.trigger, TriageTrigger::StatusChange);
    assert_eq!(decision.engine, Some(EngineUse::Used));
    assert_eq!(decision.decided, Lane::Agent);
    assert_eq!(decision.effective, Lane::Agent);
    assert_eq!(decision.engine_error, None);
    assert_eq!(fakes.engine.triage_requests().len(), 1);
    let written = vec!["area:checkout", "lane:agent", "type:bugfix"];
    assert_eq!(labels(&fakes).await, written);
    let calls = lane.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, KEY);
    assert_eq!(calls[0].2, written);
}

// S3.5: a configured engine that fails never falls back to the rules.
#[tokio::test]
async fn a_failing_engine_sends_a_status_change_to_the_human_lane() {
    let fakes = starting(FakeDecisionEngine::new().with_triage(Err(EngineError::Retryable(529))));
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.json(), accepted());

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.trigger, TriageTrigger::StatusChange);
    assert_eq!(decision.engine, Some(EngineUse::Unavailable));
    assert_eq!(
        decision.decided,
        Lane::Human(vec![HumanReason::EngineUnavailable])
    );
    assert!(decision.answers.is_none());
    assert!(decision.engine_error.as_deref().unwrap().contains("529"));
    assert_eq!(labels(&fakes).await, vec!["area:checkout", "lane:human"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.4: the issue is re-read; a ticket that already left the status is dropped.
#[tokio::test]
async fn an_issue_that_left_the_start_status_is_not_triaged() {
    let fakes = starting(FakeDecisionEngine::new().with_triage(Ok(confident_answers("checkout"))));
    seed(&fakes, "Fix cart", "To Do", &["area:checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json(), accepted());

    assert!(decisions(&fakes).await.is_empty());
    assert!(fakes.engine.triage_requests().is_empty());
    assert_eq!(labels(&fakes).await, vec!["area:checkout"]);
    assert!(fakes.tracker.suggested_labels(KEY).is_empty());
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.6: without an engine, the ticket's own area label opens the agent lane.
#[tokio::test]
async fn without_an_engine_an_area_labelled_ticket_goes_to_the_agent_lane() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout", "ux"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json(), accepted());

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.trigger, TriageTrigger::StatusChange);
    assert_eq!(decision.engine, Some(EngineUse::NotConfigured));
    assert_eq!(decision.decided, Lane::Agent);
    assert_eq!(decision.effective, Lane::Agent);
    assert!(decision.answers.is_none());
    assert!(
        decision.engine_error.is_some(),
        "the store requires a cause"
    );
    // S3.8: both facts are part of the stored decision JSON.
    let stored = serde_json::to_value(&decision).unwrap();
    assert_eq!(stored["trigger"], "status_change");
    assert_eq!(stored["engine"], "not_configured");

    assert_eq!(
        labels(&fakes).await,
        vec!["area:checkout", "ux", "lane:agent"]
    );
    let calls = lane.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, KEY);
    assert_eq!(calls[0].2, vec!["lane:agent"]);
}

// S3.6: no area label of `[areas]` means nothing says where an agent may write.
#[tokio::test]
async fn without_an_engine_a_ticket_without_a_known_area_goes_to_the_human_lane() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:warehouse", "checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.json(), accepted());

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.engine, Some(EngineUse::NotConfigured));
    let human = Lane::Human(vec![HumanReason::NoAreaLabel]);
    assert_eq!(decision.decided, human);
    assert_eq!(decision.effective, human);
    assert_eq!(
        serde_json::to_value(&decision.decided).unwrap(),
        json!({"lane": "human", "reasons": ["no_area_label"]})
    );
    assert_eq!(
        labels(&fakes).await,
        vec!["area:warehouse", "checkout", "lane:human"]
    );
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.6 and S3.7: the hard rules apply without an engine and win over the label.
#[tokio::test]
async fn without_an_engine_the_hard_rules_still_apply() {
    let cases = [
        (
            "infra/terraform/main.tf",
            FakeImpactAnalyzer::new().with_human_only("infra/terraform/main.tf"),
            HumanReason::HardRulePath,
        ),
        (
            "db/migrations/0007_orders.sql",
            FakeImpactAnalyzer::new(),
            HumanReason::SchemaMigration,
        ),
        (
            "web/src/checkout/cart.ts",
            FakeImpactAnalyzer::new().with_fan_out("web/src/checkout/cart.ts", 11),
            HumanReason::FanOutTooWide,
        ),
    ];
    for (path, impact, reason) in cases {
        let fakes = starting_with(
            FakeDecisionEngine::not_configured(),
            impact.with_mention(path, path),
        );
        seed(&fakes, &format!("Change {path}"), START, &["area:checkout"]);
        let (state, lane) = with_lane(active(state(&fakes)));

        let res = deliver(state, moved(START, "10402")).await;
        assert_eq!(res.json(), accepted(), "{reason:?}");

        let decision = only_decision(&fakes).await;
        assert_eq!(decision.decided, Lane::Human(vec![reason]), "{reason:?}");
        assert_eq!(decision.effective, Lane::Human(vec![reason]), "{reason:?}");
        assert_eq!(labels(&fakes).await, vec!["area:checkout", "lane:human"]);
        assert!(lane.calls.lock().unwrap().is_empty(), "{reason:?}");
    }
}

struct BrokenAnalyzer;

impl ImpactAnalyzer for BrokenAnalyzer {
    fn fan_out(&self, _: &[String]) -> Result<ImpactFacts, ImpactError> {
        Err(ImpactError::Io("checkout missing".into()))
    }
    fn areas_for(&self, _: &[String]) -> Vec<Area> {
        Vec::new()
    }
    fn resolve_mentions(&self, _: &[String]) -> Vec<String> {
        Vec::new()
    }
}

// Unknown facts mean the hard rules cannot be checked: never the agent lane.
#[tokio::test]
async fn without_an_engine_a_failed_impact_analysis_fails_closed() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let mut state = active(state(&fakes));
    state.impact = Arc::new(BrokenAnalyzer);
    let (state, lane) = with_lane(state);

    deliver(state, moved(START, "10402")).await;

    let decision = only_decision(&fakes).await;
    assert_eq!(
        decision.decided,
        Lane::Human(vec![HumanReason::EngineUnavailable])
    );
    assert!(decision.engine_error.as_deref().unwrap().contains("impact"));
    assert_eq!(labels(&fakes).await, vec!["area:checkout", "lane:human"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// `sensitive = true` is a rule of `target.toml`, not an engine answer.
#[tokio::test]
async fn without_an_engine_a_sensitive_area_label_goes_to_the_human_lane() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix invoices", START, &["area:billing"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    deliver(state, moved(START, "10402")).await;

    let decision = only_decision(&fakes).await;
    assert_eq!(
        decision.decided,
        Lane::Human(vec![HumanReason::SensitiveArea])
    );
    assert_eq!(labels(&fakes).await, vec!["area:billing", "lane:human"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.7: Shadow Mode records the decision and touches nothing else.
#[tokio::test]
async fn shadow_mode_never_enqueues_or_labels_a_status_change() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let mut state = state(&fakes);
    state.thresholds.mode = Mode::Shadow;
    let (state, lane) = with_lane(state);

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.json(), accepted());

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.mode, Mode::Shadow);
    assert_eq!(decision.decided, Lane::Agent);
    assert_eq!(
        decision.effective,
        Lane::Human(vec![HumanReason::ShadowMode])
    );
    assert_eq!(labels(&fakes).await, vec!["area:checkout"]);
    assert_eq!(fakes.tracker.suggested_labels(KEY), vec!["lane:agent"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.7: a decision the log refused never reaches the agent lane.
#[tokio::test]
async fn an_unrecorded_status_decision_never_reaches_the_agent_lane() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let mut state = active(state(&fakes));
    state.decisions = Some(Arc::new(DownLog));
    let (state, lane) = with_lane(state);

    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.json(), accepted());

    assert_eq!(labels(&fakes).await, vec!["area:checkout", "lane:human"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.7: `issue_created` without an engine keeps failing closed, label or not.
#[tokio::test]
async fn issue_created_without_an_engine_still_goes_to_the_human_lane() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));

    let created = json!({"webhookEvent": "jira:issue_created", "issue": {"key": KEY}});
    let res = deliver(state, created).await;
    assert_eq!(
        res.json(),
        json!({"accepted": true, "event": "issue_created", "key": KEY})
    );

    let decision = only_decision(&fakes).await;
    assert_eq!(decision.trigger, TriageTrigger::IssueCreated);
    assert_eq!(decision.engine, Some(EngineUse::NotConfigured));
    assert_eq!(
        decision.decided,
        Lane::Human(vec![HumanReason::EngineUnavailable])
    );
    assert_eq!(labels(&fakes).await, vec!["area:checkout", "lane:human"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.1 and S3.2: an unlisted status, or no list at all, is not an event.
#[tokio::test]
async fn a_move_to_another_status_or_without_start_statuses_is_ignored() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", "Done", &["area:checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));
    let res = deliver(state, moved("Done", "10402")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["accepted"], false);
    assert!(decisions(&fakes).await.is_empty());
    assert!(lane.calls.lock().unwrap().is_empty());

    // No `start_statuses`: the delivery is answered exactly as before.
    let fakes = Fakes::new(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let (state, lane) = with_lane(active(fakes.state()));
    let res = deliver(state, moved(START, "10402")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.json(),
        json!({"accepted": false, "reason": "no label change"})
    );
    assert!(decisions(&fakes).await.is_empty());
    assert!(fakes.engine.triage_requests().is_empty());
    assert_eq!(labels(&fakes).await, vec!["area:checkout"]);
    assert!(lane.calls.lock().unwrap().is_empty());
}

// S3.9: a redelivery is dropped; a later move to the same status is not.
#[tokio::test]
async fn a_redelivered_status_change_is_triaged_once() {
    let fakes = starting(FakeDecisionEngine::not_configured());
    seed(&fakes, "Fix cart", START, &["area:checkout"]);
    let (state, lane) = with_lane(active(state(&fakes)));
    let tasks = state.tasks.clone();
    let router = guard_server::router(state);

    let first = send(router.clone(), jira_hook(moved(START, "10402"))).await;
    assert_eq!(first.status, StatusCode::ACCEPTED);
    tasks.wait_idle().await;

    let again = send(router.clone(), jira_hook(moved(START, "10402"))).await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(
        again.json(),
        json!({
            "accepted": false,
            "reason": "duplicate delivery of status_changed for SHOP-7"
        })
    );
    tasks.wait_idle().await;
    assert_eq!(decisions(&fakes).await.len(), 1);
    assert_eq!(lane.calls.lock().unwrap().len(), 1);

    // Moved away and back: another change, so another triage.
    let later = send(router, jira_hook(moved(START, "10407"))).await;
    assert_eq!(later.status, StatusCode::ACCEPTED);
    tasks.wait_idle().await;
    assert_eq!(lane.calls.lock().unwrap().len(), 2);
}
