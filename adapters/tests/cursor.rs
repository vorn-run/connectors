//! Cursor's CLI agent, added as a package alone: launched with a prompt,
//! resumed by chat id, run headless in print mode and found on PATH.

mod support;

use std::fs;

use vorn_agents::launch::{self, LaunchRequest, Machine, Platform, Quoting};
use vorn_agents::{detect, Agent, AgentCommand};

const POSIX: Machine = Machine {
    platform: Platform::Posix,
    quoting: Quoting::Posix,
};

const CHAT: &str = "4da6bbd8-3342-48ac-8b8e-136cceaa72e7";

fn cursor() -> Agent {
    support::agent("cursor")
}

fn line(req: &LaunchRequest, config: Option<&AgentCommand>) -> String {
    launch::launch_line(req, config, &[], &POSIX).unwrap()
}

fn configured(args: &[&str]) -> AgentCommand {
    AgentCommand {
        command: "cursor-agent".into(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        headless_args: None,
    }
}

#[test]
fn cursor_launches_with_its_prompt_and_resumes_a_chat_by_id() {
    let mut req = LaunchRequest::new(cursor());
    assert_eq!(line(&req, None), "cursor-agent --model auto");
    req.initial_prompt = Some("plan it".into());
    assert_eq!(line(&req, None), "cursor-agent --model auto 'plan it'");
    let mut resumed = LaunchRequest::new(cursor());
    resumed.resume_session_id = Some(CHAT.into());
    assert_eq!(
        line(&resumed, None),
        format!("cursor-agent --model auto --resume {CHAT}")
    );
    // It mints its own chat ids, so a fresh session is not pinned to one.
    assert!(!cursor().pins_session_ids());
    let mut fresh = LaunchRequest::new(cursor());
    fresh.session_id = Some(CHAT.into());
    assert_eq!(line(&fresh, None), "cursor-agent --model auto");
}

#[test]
fn cursor_resume_replaces_a_chat_the_configured_line_picks() {
    let mut req = LaunchRequest::new(cursor());
    req.resume_session_id = Some(CHAT.into());
    for args in [
        &["--continue"][..],
        &["--resume"],
        &["--resume", "old-chat"],
        &["--resume=old-chat"],
    ] {
        let mut with = configured(args);
        with.args.insert(0, "--sandbox".into());
        with.args.insert(1, "enabled".into());
        assert_eq!(
            line(&req, Some(&with)),
            format!("cursor-agent --sandbox enabled --resume {CHAT}"),
            "{args:?}"
        );
    }
}

#[test]
fn cursor_takes_its_model_with_the_model_flag_in_place_of_auto() {
    let mut req = LaunchRequest::new(cursor());
    req.model = Some("composer-2.5".into());
    assert_eq!(line(&req, None), "cursor-agent --model composer-2.5");
    let set = configured(&["--model", "auto", "--sandbox", "enabled"]);
    assert_eq!(
        line(&req, Some(&set)),
        "cursor-agent --sandbox enabled --model composer-2.5"
    );
}

#[test]
fn cursor_runs_headless_in_print_mode_with_the_prompt_on_stdin() {
    let mut req = LaunchRequest::new(cursor());
    req.initial_prompt = Some("fix the tests".into());
    let run = launch::headless_spawn(&req, None, &[], &POSIX).unwrap();
    assert!(run.command.ends_with("cursor-agent"), "{}", run.command);
    assert_eq!(
        run.args,
        [
            "--force",
            "--trust",
            "--approve-mcps",
            "--model",
            "auto",
            "-p"
        ]
    );
    assert_eq!(run.stdin.as_deref(), Some("fix the tests"));

    req.resume_session_id = Some(CHAT.into());
    let again = launch::headless_spawn(&req, None, &[], &POSIX).unwrap();
    assert_eq!(
        again.args,
        [
            "--force",
            "--trust",
            "--approve-mcps",
            "--model",
            "auto",
            "--resume",
            CHAT,
            "-p"
        ]
    );

    // With no prompt it reads an empty stdin and stops with an error, as Cursor needs one.
    let bare = launch::headless_spawn(&LaunchRequest::new(cursor()), None, &[], &POSIX).unwrap();
    assert_eq!(
        bare.args,
        [
            "--force",
            "--trust",
            "--approve-mcps",
            "--model",
            "auto",
            "-p"
        ]
    );
    assert_eq!(bare.stdin, None);
    assert!(!cursor().spec().headless.as_ref().unwrap().stream);
}

#[cfg(unix)]
#[test]
fn cursor_is_found_on_path_by_its_command() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let agents = vorn_agents::Agents::new([cursor()]);
    let found = |path: &str| detect::installed(&agents, Agent::default_command, Some(path));
    assert!(!found(&path)[0].1);

    // Its newer name alone is not taken for it.
    let bin = dir.path().join("agent");
    fs::write(&bin, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!found(&path)[0].1);

    let bin = dir.path().join("cursor-agent");
    fs::write(&bin, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(found(&path)[0].1);
}

#[test]
fn cursor_offers_vorn_mcp_from_its_own_config() {
    let spec = cursor();
    let mcp = spec.spec().mcp.as_ref().unwrap();
    assert!(!mcp.in_agent);
    assert_eq!(mcp.commands, ["cursor-agent mcp enable vorn"]);
    let note = mcp.note.as_deref().unwrap();
    assert!(note.contains("~/.cursor/mcp.json"), "{note}");
    assert!(note.contains("\"mcpServers\""), "{note}");
}
