mod harness;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bb_core::{RunnerErrorCode, RunnerEventBody};
use bb_procs::Terminals;
use bb_procs::terminals::{
    AttachTerminalArgs, OpenTerminalArgs, ResizeTerminalArgs, TerminalExit, TerminalOutputChunk,
    TerminalRef, TerminalStart, WriteTerminalArgs,
};
use harness::{Harness, failure_code, until};

const TAIL_BYTES: usize = 1024 * 1024;

fn decode<'a>(chunks: impl IntoIterator<Item = &'a str>) -> String {
    let bytes: Vec<u8> = chunks.into_iter().flat_map(|data| BASE64.decode(data).unwrap()).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn replay_text(chunks: &[TerminalOutputChunk]) -> String {
    decode(chunks.iter().map(|chunk| chunk.data_base64.as_str()))
}

fn output(h: &Harness, id: &str, from_seq: u64) -> String {
    let events = h.bodies();
    let data = events.iter().filter_map(|(seq, body)| match body {
        RunnerEventBody::TerminalOutput { terminal_id, data_base64 }
            if terminal_id == id && seq.unwrap_or(0) >= from_seq =>
        {
            Some(data_base64.as_str())
        }
        _ => None,
    });
    decode(data)
}

fn exit_of(h: &Harness, id: &str) -> Option<Option<i32>> {
    h.bodies().into_iter().find_map(|(_, body)| match body {
        RunnerEventBody::TerminalExited { terminal_id, exit_code } if terminal_id == id => {
            Some(exit_code)
        }
        _ => None,
    })
}

async fn type_in(terminals: &Terminals, id: &str, text: &str) -> bb_core::RunnerResult<()> {
    let data_base64 = BASE64.encode(text);
    terminals.write(WriteTerminalArgs { terminal_id: id.into(), data_base64 }).await
}

async fn open(
    h: &Harness,
    terminals: &Terminals,
    id: &str,
    command: &str,
) -> bb_procs::terminals::TerminalOpened {
    let env = [("GREETING".to_owned(), "hello".to_owned())].into_iter().collect();
    let cwd = Some(h.path().display().to_string());
    let start = TerminalStart::Command { command: command.into() };
    let args = OpenTerminalArgs { terminal_id: id.into(), cwd, cols: 80, rows: 24, start, env };
    terminals.open(args).await.unwrap()
}

#[tokio::test]
async fn echoes_input_resizes_replays_from_a_sequence_and_reports_the_exit_code() {
    let h = Harness::new();
    let terminals = Terminals::new(h.ctx.clone());
    let id = "term_1";
    let opened = open(&h, &terminals, id, "exec sh").await;
    assert_eq!(opened.title, "exec sh");
    assert_eq!(opened.initial_cwd, h.path().display().to_string());
    assert_eq!(terminals.live_ids(), [id]);

    let greet = "echo \"$GREETING from $BB_TERMINAL_SESSION_ID\"; stty size\n";
    type_in(&terminals, id, greet).await.unwrap();
    until("echoed output", || {
        let text = output(&h, id, 0);
        (text.contains("hello from term_1\r\n24 80") || text.contains("hello from term_1\n24 80"))
            .then_some(())
    })
    .await;
    let all = |since_seq, tail_bytes| AttachTerminalArgs {
        terminal_id: id.into(),
        since_seq,
        tail_bytes,
    };
    let before = terminals.attach(all(0, TAIL_BYTES)).await.unwrap();
    let seqs: Vec<u64> = before.chunks.iter().map(|chunk| chunk.seq).collect();
    assert_eq!(seqs, (0..seqs.len() as u64).collect::<Vec<_>>());
    assert_eq!(before.replay_start_seq, 0);
    assert_eq!(before.next_seq, seqs.len() as u64);

    let resize = ResizeTerminalArgs { terminal_id: id.into(), cols: 100, rows: 30 };
    terminals.resize(resize).await.unwrap();
    type_in(&terminals, id, "stty size\n").await.unwrap();
    let since_seq = before.next_seq;
    until("resized output", || output(&h, id, since_seq).contains("30 100").then_some(())).await;
    let replay = terminals.attach(all(since_seq, TAIL_BYTES)).await.unwrap();
    assert_eq!(replay.replay_start_seq, since_seq);
    assert!(replay_text(&replay.chunks).contains("30 100"));
    assert!(!replay_text(&replay.chunks).contains("hello from"));

    type_in(&terminals, id, "exit 7\n").await.unwrap();
    assert_eq!(until("term_1 to exit", || exit_of(&h, id)).await, Some(7));
    assert!(terminals.live_ids().is_empty());
    let after = terminals.attach(all(0, 16)).await.unwrap();
    assert_eq!(after.exited, Some(TerminalExit { exit_code: Some(7) }));
    assert_eq!(after.chunks.last().map(|chunk| chunk.seq), Some(after.next_seq - 1));
    assert!((after.chunks.len() as u64) < after.next_seq);
    let code = failure_code(type_in(&terminals, id, "x")).await;
    assert_eq!(code, RunnerErrorCode::TerminalNotFound);

    open(&h, &terminals, "term_2", "sleep 60").await;
    terminals.close(TerminalRef { terminal_id: "term_2".into() }).await.unwrap();
    until("term_2 to exit", || exit_of(&h, "term_2")).await;
    terminals.dispose();
}

#[tokio::test]
async fn rejects_a_second_open_and_answers_device_attribute_queries() {
    let h = Harness::new();
    let terminals = Terminals::new(h.ctx.clone());
    open(&h, &terminals, "term_da", "printf 'a\\033[cb'; read reply; echo got").await;
    let env = Default::default();
    let start = TerminalStart::Shell;
    let again = OpenTerminalArgs {
        terminal_id: "term_da".into(),
        cwd: None,
        cols: 80,
        rows: 24,
        start,
        env,
    };
    assert_eq!(failure_code(terminals.open(again)).await, RunnerErrorCode::Conflict);
    type_in(&terminals, "term_da", "\n").await.unwrap();
    until("term_da to exit", || exit_of(&h, "term_da")).await;
    let text = output(&h, "term_da", 0);
    assert!(text.contains("ab"), "{text:?}");
    assert!(!text.contains("\u{1b}[c"));
    let missing = TerminalRef { terminal_id: "nope".into() };
    terminals.close(missing).await.unwrap();
    terminals.dispose();
}
