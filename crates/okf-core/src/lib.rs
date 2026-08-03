//! Deterministic Open Knowledge Format semantics shared by the editor and CLI.
//!
//! This crate intentionally has no filesystem, terminal, editor, Webview, network, or
//! asynchronous runtime dependency. Callers enumerate documents and apply change plans.

mod graph;
mod model;
mod parser;
mod templates;
mod validation;

pub use graph::build_graph_payload_checked;
pub use model::*;
pub use parser::parse_bundle;
pub use templates::{
    AgentTarget, BundlePreset, ConceptTemplateInput, IndexMode, RenderedFile, agent_files,
    agent_files_checked, agent_files_provider_checked, bundle_preset_files,
    bundle_preset_files_checked, concept_template_file, concept_template_file_checked, index_files,
};
pub use validation::{is_future_minor_version, validate_bundle};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ABI_VERSION: u32 = 1;
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "operation", content = "input")]
pub enum CoreRequest {
    Metadata,
    Inspect(InspectInput),
    Parse(ParseBundleInput),
    Validate(ValidateInput),
    Graph(ParseBundleInput),
    RenderBundle(RenderBundleInput),
    RenderConcept(ConceptTemplateInput),
    RenderIndexes(RenderIndexesInput),
    RenderAgent(RenderAgentInput),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectInput {
    pub bundle: ParseBundleInput,
    pub now: String,
    #[serde(default)]
    pub failures: Vec<ParseFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateInput {
    pub bundle: ParsedBundle,
    pub now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBundleInput {
    pub preset: BundlePreset,
    pub timestamp: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderIndexesInput {
    pub bundle: ParseBundleInput,
    pub mode: IndexMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderAgentInput {
    pub target: AgentTarget,
    #[serde(default = "default_bundle_path")]
    pub bundle_path: Value,
}

fn default_bundle_path() -> Value {
    Value::String(".".to_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreResponse {
    pub abi_version: u32,
    pub core_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreErrorBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreErrorBody {
    pub code: &'static str,
    pub message: String,
}

impl CoreResponse {
    fn success<T: Serialize>(value: T) -> Self {
        match serde_json::to_value(value) {
            Ok(result) => Self {
                abi_version: ABI_VERSION,
                core_version: CORE_VERSION,
                result: Some(result),
                error: None,
            },
            Err(error) => Self::failure("serialization-failed", error.to_string()),
        }
    }

    fn failure(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            abi_version: ABI_VERSION,
            core_version: CORE_VERSION,
            result: None,
            error: Some(CoreErrorBody {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    abi_version: u32,
    core_version: &'static str,
    capabilities: [&'static str; 7],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    bundle: ParsedBundle,
    findings: Vec<Finding>,
    graph: GraphPayload,
}

/// Dispatch one versioned JSON request without granting the core any ambient capability.
pub fn dispatch_json(request_json: &str) -> String {
    let request = match serde_json::from_str::<CoreRequest>(request_json) {
        Ok(request) => request,
        Err(error) => {
            if graph_request_has_invalid_revision(request_json) {
                return serialize_response(CoreResponse::failure(
                    "graph-resource-limit",
                    "The graph revision must be a non-negative safe integer.",
                ));
            }
            return serialize_response(CoreResponse::failure(
                "invalid-request",
                format!("The OKF core request is invalid: {error}"),
            ));
        }
    };

    let response = match request {
        CoreRequest::Metadata => CoreResponse::success(Metadata {
            abi_version: ABI_VERSION,
            core_version: CORE_VERSION,
            capabilities: [
                "parse",
                "validate",
                "graph",
                "bundle-template",
                "concept-template",
                "indexes",
                "agent-template",
            ],
        }),
        CoreRequest::Inspect(input) => {
            if validation::parse_reference_time(&input.now).is_none() {
                return serialize_response(CoreResponse::failure(
                    "invalid-request",
                    "ValidationOptions.now must be a valid Date or ISO date-time string.",
                ));
            }
            let mut bundle = parse_bundle(input.bundle);
            bundle.failures.extend(input.failures);
            if let Some(message) = graph::inspect_prevalidation_graph_error(&bundle) {
                return serialize_response(CoreResponse::failure("graph-resource-limit", message));
            }
            bundle.failures.sort_by(|left, right| {
                compare_utf16(&left.bundle_path, &right.bundle_path)
                    .then_with(|| compare_utf16(&left.uri, &right.uri))
                    .then_with(|| left.reason.cmp(&right.reason))
            });
            let findings = validate_bundle(&bundle, &input.now);
            bundle.findings.clone_from(&findings);
            let graph = match build_graph_payload_checked(&bundle) {
                Ok(graph) => graph,
                Err(message) => {
                    return serialize_response(CoreResponse::failure(
                        "graph-resource-limit",
                        message,
                    ));
                }
            };
            CoreResponse::success(Inspection {
                bundle,
                findings,
                graph,
            })
        }
        CoreRequest::Parse(input) => CoreResponse::success(parse_bundle(input)),
        CoreRequest::Validate(input) => {
            if validation::parse_reference_time(&input.now).is_none() {
                CoreResponse::failure(
                    "invalid-request",
                    "ValidationOptions.now must be a valid Date or ISO date-time string.",
                )
            } else {
                CoreResponse::success(validate_bundle(&input.bundle, &input.now))
            }
        }
        CoreRequest::Graph(input) => {
            let bundle = parse_bundle(input);
            match build_graph_payload_checked(&bundle) {
                Ok(graph) => CoreResponse::success(graph),
                Err(message) => CoreResponse::failure("graph-resource-limit", message),
            }
        }
        CoreRequest::RenderBundle(input) => {
            match bundle_preset_files_checked(input.preset, &input.timestamp) {
                Ok(files) => CoreResponse::success(files),
                Err(message) => CoreResponse::failure("invalid-request", message),
            }
        }
        CoreRequest::RenderConcept(input) => match concept_template_file_checked(&input) {
            Ok(file) => CoreResponse::success(file),
            Err(message) => CoreResponse::failure("unsafe-relative-path", message),
        },
        CoreRequest::RenderIndexes(input) => {
            let mut bundle = parse_bundle(input.bundle);
            if matches!(input.mode, IndexMode::Missing) {
                // The ABI mirrors the TypeScript renderer, which plans against an empty
                // existing-index set and leaves collision/merge handling to its caller.
                bundle.reserved_documents.clear();
            }
            CoreResponse::success(index_files(&bundle, input.mode))
        }
        CoreRequest::RenderAgent(input) => {
            let rendered = match input.bundle_path {
                Value::String(path) => agent_files_checked(input.target, &path),
                Value::Object(path)
                    if path.get("pathIdentity").and_then(Value::as_str) == Some("provider") =>
                {
                    path.get("relativePath")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "A non-empty provider-relative path is required.".to_owned())
                        .and_then(|path| agent_files_provider_checked(input.target, path))
                }
                _ => Err("A non-empty relative path is required.".to_owned()),
            };
            match rendered {
                Ok(files) => CoreResponse::success(files),
                Err(message) => CoreResponse::failure("unsafe-relative-path", message),
            }
        }
    };
    serialize_response(response)
}

fn graph_request_has_invalid_revision(request_json: &str) -> bool {
    #[derive(Deserialize)]
    struct RequestProbe {
        operation: Option<String>,
        input: Option<Box<serde_json::value::RawValue>>,
    }

    #[derive(Deserialize)]
    struct RevisionProbe {
        revision: Option<Box<serde_json::value::RawValue>>,
    }

    #[derive(Deserialize)]
    struct InspectProbe {
        bundle: Option<Box<serde_json::value::RawValue>>,
    }

    let Ok(request) = serde_json::from_str::<RequestProbe>(request_json) else {
        return false;
    };
    let Some(input) = request.input else {
        return false;
    };
    let revision = match request.operation.as_deref() {
        Some("graph") => {
            let Ok(input) = serde_json::from_str::<RevisionProbe>(input.get()) else {
                return false;
            };
            input.revision
        }
        Some("inspect") => {
            let Ok(input) = serde_json::from_str::<InspectProbe>(input.get()) else {
                return false;
            };
            let Some(bundle) = input.bundle else {
                return false;
            };
            let Ok(bundle) = serde_json::from_str::<RevisionProbe>(bundle.get()) else {
                return false;
            };
            bundle.revision
        }
        _ => return false,
    };
    let Some(revision) = revision else {
        return true;
    };
    parse_revision_json_number(revision.get())
        .is_none_or(|revision| revision > 9_007_199_254_740_991)
}

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn serialize_response(response: CoreResponse) -> String {
    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"abiVersion":1,"coreVersion":"unknown","error":{"code":"serialization-failed","message":"The OKF core response could not be serialized."}}"#.to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_versioned() {
        let response: Value =
            serde_json::from_str(&dispatch_json(r#"{"operation":"metadata"}"#)).unwrap();
        assert_eq!(response["abiVersion"], 1);
        assert_eq!(response["result"]["abiVersion"], 1);
        assert_eq!(response["error"], Value::Null);
    }

    #[test]
    fn invalid_json_is_data_not_a_panic() {
        let response: Value = serde_json::from_str(&dispatch_json("{")).unwrap();
        assert_eq!(response["error"]["code"], "invalid-request");
    }

    #[test]
    fn graph_operation_rejects_an_unsafe_revision() {
        let response: Value = serde_json::from_str(&dispatch_json(
            r#"{"operation":"graph","input":{"rootUri":"","revision":9007199254740992,"documents":[]}}"#,
        ))
        .unwrap();
        assert_eq!(response["error"]["code"], "graph-resource-limit");
        assert_eq!(
            response["error"]["message"],
            "The graph revision must be a non-negative safe integer."
        );
    }

    #[test]
    fn graph_operations_normalize_overflowing_revision_errors() {
        for operation in ["graph", "inspect"] {
            for revision in ["1e400", "-1e400", "1e+400", "-1e+400"] {
                let request = if operation == "graph" {
                    format!(
                        r#"{{"operation":"graph","input":{{"rootUri":"","revision":{revision},"documents":[]}}}}"#
                    )
                } else {
                    format!(
                        r#"{{"operation":"inspect","input":{{"bundle":{{"rootUri":"","revision":{revision},"documents":[]}},"now":"2026-08-03T00:00:00Z","failures":[]}}}}"#
                    )
                };
                let response: Value = serde_json::from_str(&dispatch_json(&request)).unwrap();
                assert_eq!(
                    response["error"]["code"], "graph-resource-limit",
                    "{operation} revision {revision}"
                );
                assert_eq!(
                    response["error"]["message"],
                    "The graph revision must be a non-negative safe integer.",
                    "{operation} revision {revision}"
                );
            }
        }
    }

    #[test]
    fn graph_operations_normalize_negative_and_fractional_revision_errors() {
        for request in [
            r#"{"operation":"graph","input":{"rootUri":"","revision":-1,"documents":[]}}"#,
            r#"{"operation":"graph","input":{"rootUri":"","revision":-0.5,"documents":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":-1,"documents":[]},"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":-0.5,"documents":[]},"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
        ] {
            let response: Value = serde_json::from_str(&dispatch_json(request)).unwrap();
            assert_eq!(response["error"]["code"], "graph-resource-limit");
            assert_eq!(
                response["error"]["message"],
                "The graph revision must be a non-negative safe integer."
            );
        }
    }

    #[test]
    fn graph_operation_accepts_lexically_float_integral_revisions() {
        for (revision, expected) in [
            ("0.0", 0_u64),
            ("0e999999999999999999999999", 0),
            ("0e-999999999999999999999999", 0),
            ("1e-400", 0),
            ("-1e-400", 0),
            ("1.0", 1),
            ("1e0", 1),
            ("9007199254740990.9", 9_007_199_254_740_991),
            ("9007199254740991.0", 9_007_199_254_740_991),
        ] {
            let graph: Value = serde_json::from_str(&dispatch_json(&format!(
                r#"{{"operation":"graph","input":{{"rootUri":"","revision":{revision},"documents":[]}}}}"#
            )))
            .unwrap();
            assert_eq!(graph["error"], Value::Null, "graph revision {revision}");
            assert_eq!(graph["result"]["revision"], expected);

            let inspect: Value = serde_json::from_str(&dispatch_json(&format!(
                r#"{{"operation":"inspect","input":{{"bundle":{{"rootUri":"","revision":{revision},"documents":[]}},"now":"2026-08-03T00:00:00Z","failures":[]}}}}"#
            )))
            .unwrap();
            assert_eq!(inspect["error"], Value::Null, "inspect revision {revision}");
            assert_eq!(inspect["result"]["graph"]["revision"], expected);
        }
    }

    #[test]
    fn a_valid_rounded_revision_does_not_mask_an_unrelated_invalid_request() {
        for request in [
            r#"{"operation":"graph","input":{"rootUri":"","revision":9007199254740990.9}}"#,
            r#"{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":9007199254740990.9},"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
            r#"{"operation":"graph","input":{"rootUri":"","revision":1,"revision":1,"documents":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":1,"documents":[]},"bundle":{"rootUri":"","revision":1,"documents":[]},"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
        ] {
            let response: Value = serde_json::from_str(&dispatch_json(request)).unwrap();
            assert_eq!(response["error"]["code"], "invalid-request");
        }
    }

    #[test]
    fn structural_graph_and_inspect_errors_remain_invalid_requests() {
        for request in [
            r#"{"operation":"graph"}"#,
            r#"{"operation":"graph","input":null}"#,
            r#"{"operation":"graph","input":1}"#,
            r#"{"operation":"graph","input":[]}"#,
            r#"{"operation":"graph","input":{"rootUri":"","revision":1e400,"documents":[]},"input":{"rootUri":"","revision":1e400,"documents":[]}}"#,
            r#"{"operation":"inspect"}"#,
            r#"{"operation":"inspect","input":null}"#,
            r#"{"operation":"inspect","input":1}"#,
            r#"{"operation":"inspect","input":[]}"#,
            r#"{"operation":"inspect","input":{"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":null,"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":1,"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
            r#"{"operation":"inspect","input":{"bundle":{"rootUri":"","revision":1e400,"documents":[]},"now":"2026-08-03T00:00:00Z","failures":[]},"input":{"bundle":{"rootUri":"","revision":1e400,"documents":[]},"now":"2026-08-03T00:00:00Z","failures":[]}}"#,
        ] {
            let response: Value = serde_json::from_str(&dispatch_json(request)).unwrap();
            assert_eq!(response["error"]["code"], "invalid-request", "{request}");
            assert!(
                response["error"]["message"]
                    .as_str()
                    .is_some_and(|message| message.starts_with("The OKF core request is invalid:")),
                "{request}"
            );
        }
    }
}
