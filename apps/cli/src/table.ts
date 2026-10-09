import * as people from "./commands/people.js";
import * as system from "./commands/system.js";
import * as terminal from "./commands/terminal.js";
import * as threadMore from "./commands/thread-more.js";
import * as thread from "./commands/thread.js";
import * as workspace from "./commands/workspace.js";
import { parseCommands, type Table } from "./engine.js";

const SELF = "  --self  Target the current thread (BB_THREAD_ID)";
const YES = "  --yes  Skip the confirmation prompt";
const MACHINE = "  --machine|host <id-or-name>";
const EXECUTION = `
  --model <model>  Model ID
  --reasoning-level <level>  none, low, medium, high, xhigh, max, ultra, …
  --permission-mode <mode>  accept-edits, auto or full`;
const ATTACHMENTS = `
  --file <path>...  Attach a file; an absolute path here is uploaded first
  --image <path>...  Attach an image the same way
  --send-at <when>  ISO time (2026-08-25T09:00) or delay (30s, 10m, 2h)`;
const TERMINAL_SCOPE = `
  --thread <id>  Terminal of a thread (inside one: $BB_THREAD_ID)
  --environment <id>  Terminal of an environment
${MACHINE}  Terminal on a machine
  --cwd <path>  Working directory, with --machine`;
const OUTPUT_BOUNDS = `
  --tail-bytes <n>  Only the latest N bytes
  --limit-chunks <n>  Only the latest N chunks`;
const ROUTING = `
${MACHINE}  Ask this machine
  --environment <id>  Ask the machine of this environment`;

const COMMANDS = `
status  Show the current project, thread, environment and server
  > {project, thread, childThreads, pendingTodos, pluginsNeedingAttention,
    dataDir, serverUrl}
guide [topic] [group]  Explain bb: concepts, threads, machines, commands, …
  $ bb guide threads
  $ bb guide commands thread
whoami  Show the user this CLI acts as
  > {user: {id, name, email, role, hasPassword, disabledAt, …}}

thread spawn|create|new  Create a thread and send its first prompt
  --project <id>  Project ID (required; inside a thread: $BB_PROJECT_ID)
  --title <title>  Thread title
  --prompt <text>  First prompt
  --prompt-file <path>  Read the prompt from a file (- reads stdin)
  --parent-self  Parent the new thread to BB_THREAD_ID
  --parent-thread <id>  Parent thread ID
  --provider <id>  Provider ID (default: the project's remembered choice)
${EXECUTION}
  --environment <id-or-path>  Reuse an environment, or run in a directory
  --new-environment <kind>  worktree, checkout or personal
  --base-branch <ref>  Git ref for a new worktree (origin/<branch>)
${MACHINE}  Machine to run on
  --section <id>  Sidebar section
  --visibility <visibility>  visible or hidden (a child inherits)
${ATTACHMENTS}
  $ bb thread spawn --project "$BB_PROJECT_ID" --parent-self --environment
    "$BB_ENVIRONMENT_ID" --provider codex --title "Fix test" --prompt "…"
  $ bb thread spawn --project proj_1 --machine build-box --new-environment
    worktree --base-branch origin/main --prompt-file brief.md
  > the created thread: {id, status, title, projectId, environmentId, …}
thread tell|message|send <id> [message]  Send a message; a busy thread queues it
  --message-file <path>  Read the message from a file (- reads stdin)
  --mode <mode>  steer (default), queue or auto
${EXECUTION}
${ATTACHMENTS}
  $ bb thread tell thr_abc "run the tests too" --mode queue
  > {threadId, delivery: "sent" | "queued", queuedMessage?, mode}
thread wait <id>  Block until a thread reaches a status (default idle) or event
  --status <status>  pending, idle, starting, active, stopping or error
  --event <type>  Wait for an event of this type instead
  --timeout <duration>  Seconds, or 90s, 20m, 4h (default 1200s)
  --poll-interval <duration>  Milliseconds, or 5s (default 250ms)
  $ bb thread wait thr_abc --status idle --timeout 25m --json
  > {threadId, matched: true, target}; exit 2 on timeout, 3 on an invalid
    request, 4 when the thread cannot reach the status
thread show|get|view|status [id]  Show a thread, its environment and its TODOs
${SELF}
  > {thread, environment, pendingTodos} (thread fields are under .thread)
thread log|messages|timeline [id]  Print the timeline, or raw events as JSON
${SELF}
  --format <format>  minimal (default), verbose or json
  --limit <count>  Events for json (default 100); turns otherwise (max 100)
  --after-seq <seq>  Events after this sequence (json only)
  --all  Page through the whole thread
  > [{id, seq, type, createdAt, threadId, scope, data}] oldest first
thread output [id]  Print the final assistant message of the last turn
${SELF}
  > {output}
thread list  List threads
  --project <id>  Only this project
  --environment <id>  Only this environment
${MACHINE}  Only this machine
  --parent-thread <id>  Only children of this thread
  --section <id>  Only this section
  --unsectioned  Only threads outside sections
  --archived  Only archived threads
  --include-hidden  Include hidden threads
  --count  Print only the number of matching threads
  > [{id, projectId, title, status, parentThreadId, …}] (bare array)
thread update [id]  Change title, parent, section, model or visibility
${SELF}
  --title <title>  New title
  --parent-thread <id>  New parent thread
  --clear-parent-thread  Remove the parent thread
  --section <id>  Move into a section
  --clear-section  Remove from its section
  --model <model>  Model for the next turn
  --reasoning-level <level>  Reasoning level for the next turn
  --visibility <visibility>  visible or hidden
thread stop [id]  Stop work and release the agent runtime
${SELF}
thread archive [id]  Archive a thread and its children
${SELF}
thread unarchive [id]  Unarchive a thread
${SELF}
thread compact [id]  Compact the context of an idle thread
${SELF}
thread clear [id]  Clear the model context of an idle thread
${SELF}
thread retry [id]  Send the failed turn of a thread again
${SELF}
  --send-at <when>  ISO time (2026-08-25T09:00) or delay (30s, 10m, 2h)
thread pin [id]  Pin a thread
${SELF}
thread unpin [id]  Unpin a thread
${SELF}
thread read [id]  Mark a thread read
${SELF}
thread unread [id]  Mark a thread unread
${SELF}
thread delete <id>  Delete a thread permanently
${YES}
  --confirm-child-threads  Also delete its child threads
thread search <query>  Search thread titles and messages
  --limit <count>  Results per group
thread open [id] [path]  Open a thread in the app, optionally with a file
  --line <number>  Line to focus
  --split <placement>  right, down, left, top or replace
  $ bb thread open thr_abc src/index.ts --line 12
  $ bb thread open notes.md
thread interactions list [id]  List approvals, questions and plugin forms
${SELF}
thread interactions show <interactionId> [id]  Show one interaction in full
${SELF}
thread interactions resolve <interactionId> [id]  Approve, deny or answer one
${SELF}
  --approve  Approve a command, file change or tool use
  --deny  Deny it
  --grant <scope>  Grant a permission request for the turn or the session
  --answer <question=value>...  Choose an option of a question
  --text <question=text>...  Answer a question in free text
  --value <json>  Answer a plugin form with a JSON value
  $ bb thread interactions resolve pint_1 thr_abc --approve
  $ bb thread interactions resolve pint_2 --self --answer staging
thread queue list [id]  List the queued messages of a thread
${SELF}
thread queue send <threadId> <messageId>  Send a queued message now
  --mode <mode>  auto (default) or steer
thread queue delete <threadId> <messageId>  Delete a queued message
thread section list  List sidebar sections
thread section create <name>  Create a sidebar section
thread section rename <id> <name>  Rename a sidebar section
thread section delete <id>  Delete a section; its threads become unsectioned
${YES}

project list  List projects
  --include-personal  Include the personal project
  > [{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path}]}]
project show <id>  Show a project and its sources
project create  Create a project from a directory on a machine
  --name <name>  Project name (required)
  --root <path>  Project directory (default: the current directory)
${MACHINE}  Machine holding it (default: this one)
project update <id>  Rename a project
  --name <name>  New name
project delete <id>  Delete a project and its threads
${YES}
project source add <projectId>  Add the project's directory on another machine
  --path <path>  Directory of an existing checkout (required)
${MACHINE}  Machine holding it (default: this one)
  --default  Make it the default source
project source update <projectId> <sourceId>  Change a source
  --path <path>  New directory
  --default  Make it the default source
project source delete <projectId> <sourceId>  Remove a project source
${YES}
project attachment upload <id>  Upload a file here as a prompt attachment
  --client-file <path>  File to upload (required)
  --filename <name>  Stored file name

env list  List environments: the checkouts and worktrees threads run in
  --project <id>  Only this project
${MACHINE}  Only this machine
  --status <status>  ready or destroyed
  --limit <count>  At most this many, oldest first
  > [{id, name, projectId, hostId, path, branchName, status}]
env show|get <id>  Show an environment
env status <id>  Show the git state of an environment
  --merge-base-branch <branch>  Also compare with this branch
env commit <id>  Commit every change in an environment
env update <id>  Rename an environment or set its merge-base branch
  --name <name>  Display name
  --clear-name  Remove the display name
  --merge-base-branch <branch>  Branch that diffs compare against
  --clear-merge-base-branch  Use the default merge base again
env delete <id>  Delete an environment that has no live threads
${YES}
env branches <id>  List the local and remote branches of an environment
  --query <query>  Branch-name filter
  --limit <count>  Maximum local and remote branches
  > {branches, branchesTruncated, remoteBranches, remoteBranchesTruncated}
env paths <id>  Search an environment's files and directories
  --query <query>  Fuzzy path query
  --limit <count>  Maximum paths
  --files  Include files
  --directories  Include directories
  > {paths: [{kind, path}], truncated}
env diff <id>  Print the changed files, stats and full diff of an environment
  --target <target>  uncommitted, branch_committed, all or commit (required)
  --merge-base-branch <branch>  Base branch, with branch_committed or all
  --sha <sha>  Commit, with --target commit
  > {outcome, diff: {files, shortstat, diff, truncated}}
env diff-files <id>  List the changed files of an environment
  --target <target>  uncommitted, branch_committed, all or commit (required)
  --merge-base-branch <branch>  Base branch, with branch_committed or all
  --sha <sha>  Commit, with --target commit
  > {outcome, files: [{path, changeKind, additions, deletions, …}], shortstat}
env diff-file <id>  Print one side of a changed file
  --target <target>  uncommitted, branch_committed, all or commit (required)
  --path <path>  Repository-relative file path (required)
  --side <side>  old or new (required)
  --merge-base-ref <sha>  Resolved merge-base SHA, with branch_committed or all
  --sha <sha>  Commit, with --target commit
env diff-patch <id>  Print the patches of chosen changed files
  --target <target>  uncommitted, branch_committed, all or commit (required)
  --path <path>...  Changed file path (required)
  --merge-base-branch <branch>  Base branch, with branch_committed or all
  --sha <sha>  Commit, with --target commit
  > {outcome, patches: [{path, patch, truncated}]}
env providers  List environment providers
  --project <id>  Only providers this project can use
${MACHINE}  Availability on this machine (needs --project)
env archive-threads <id>  Archive every active thread in an environment
  > {ok, archivedThreadIds}

machine list  List machines, their owners and who may use them
  > [{id, name, type, status, lifecycle, ownerUserId, sharing, usable,
    lastSeenAt}] (bare array)
machine show <machine>  Show a machine, by ID or name
machine add  Register a machine and print the command that joins it
  --name <name>  Machine name (default: its hostname)
machine reconnect <machine>  Print a new join command for an offline machine
machine rename <machine> <name>  Rename a machine
machine remove <machine>  Revoke and remove a machine
${YES}
machine share <machine>  Let every user run threads on a machine
machine unshare <machine>  Keep a machine to its owner
machine env list  List variables given to agents (values stay hidden)
  --project <id>  Variables of one project
machine env set <name>  Set an agent variable; the value is read from stdin
  --project <id>  Only for this project
  --note <text>  What it is for
  $ printf %s "$TOKEN" | bb machine env set NPM_TOKEN
machine env unset <name>  Remove an agent variable
  --project <id>  Only for this project

user list  List the people who can sign in
  > [{id, name, email, role, hasPassword, disabledAt, createdAt}] (bare array)
user invite  Create an invite link for a new person
  --name <name>  Their name
  --email <email>  Their email address
  --role <role>  owner or member
  $ bb user invite --name Ada --role member
  > {id, name, email, role, createdByUserId, expiresAt, createdAt, url}
user invites  List the invites nobody has accepted yet
  > [{id, name, email, role, createdByUserId, expiresAt, createdAt}]
user revoke-invite <id>  Revoke an invite
user sign-in-link [id]  Print a one-time sign-in link (default: for yourself)
  $ bb user sign-in-link
  > {url, expiresAt, userId}
user role <id> <role>  Make a user an owner or a member
  $ bb user role usr_abc owner
user disable <id>  Stop a user from signing in
user enable <id>  Let a disabled user sign in again

provider list  List providers usable on a machine
${ROUTING}
  --all  Show the whole catalog, disabled providers included
  > [{id, displayName, capabilities, …}] (bare array)
provider models [providerId]  List the models of a provider
${ROUTING}
  > [{id, model, displayName, isDefault, …}] (bare array)
provider enable <providerId>  Enable a provider for new turns
provider disable <providerId>  Disable a provider for new turns

terminal create|start [command...]  Start a shell or a command
${TERMINAL_SCOPE}
  --command <command>  Shell command to run instead of a login shell
  --title <title>  Terminal title
  --cols <n>  Columns (default 80)
  --rows <n>  Rows (default 24)
  $ bb terminal create --thread "$BB_THREAD_ID" --title dev
    --command "pnpm dev" --json
  > the session: {id, title, status, exitCode, cols, rows, …}
terminal list  List terminals in one scope
${TERMINAL_SCOPE}
  > {sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}
terminal output|read <terminalId>  Print terminal scrollback
  --since-seq <n>  Only chunks from this sequence
${OUTPUT_BOUNDS}
  > {chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode,
    closeReason}
terminal wait <terminalId>  Wait for output or exit (exit 124 if it ends first)
  --contains <text>  Wait until the output contains this text
  --regex <pattern>  Wait until the output matches
  --exit  Wait until the terminal exits
  --from-start  Search existing scrollback too
  --timeout <duration>  Seconds, or 90s, 20m (default 30s)
  --poll-interval <duration>  Milliseconds, or 2s (default 500ms)
${OUTPUT_BOUNDS}
  > {terminalId, matched, nextSeq, exitCode}
terminal send <terminalId>  Send input to a terminal
  --text <text>  Text to send
  --stdin  Send the bytes read from stdin
  --enter  Append a newline
terminal close|stop <terminalId>  Close a terminal
  --if-clean  Only if nobody typed into it

file read <path>  Print a file from a machine
${MACHINE}  Machine holding the file (default: the server's)
  --root <path>  Refuse paths outside this directory
file write <path>  Write a UTF-8 file on a machine
${MACHINE}  Machine holding the file (default: the server's)
  --content <text>  File content
  --stdin  Read the content from stdin
  --root <path>  Refuse paths outside this directory
  --create-parents  Create missing parent directories
  --expected-sha256 <hash>  Only write when the current hash matches (else exit 1, code conflict)
file list <path>  List files under a directory on a machine
${MACHINE}  Machine holding the directory (default: the server's)
  --query <query>  Fuzzy path filter
  --limit <count>  Maximum entries
  --no-hidden  Skip dot-prefixed files and directories
  --exclude <name>...  Entry names or root-relative paths to skip
file paths <path>  List matching files and directories on a machine
${MACHINE}  Machine holding the directory (default: the server's)
  --query <query>  Fuzzy path filter
  --limit <count>  Maximum entries
  --files  Include files
  --directories  Include directories
  --no-hidden  Skip dot-prefixed files and directories
  --exclude <name>...  Entry names or root-relative paths to skip
  > {paths: [{kind, path, name}], truncated}
file mkdir <path>  Create a directory on a machine
${MACHINE}  Machine holding the directory (default: the server's)
  --root <path>  Refuse paths outside this directory
  --recursive  Create missing parent directories
file move <source> <destination>  Move a file or directory on a machine
${MACHINE}  Machine holding the path (default: the server's)
  --root <path>  Refuse paths outside this directory
file remove <path>  Remove a file or directory on a machine
${MACHINE}  Machine holding the path (default: the server's)
  --root <path>  Refuse paths outside this directory
  --recursive  Remove a directory and everything in it
${YES}

settings show  Print every setting as key = value
settings get <key>  Print one setting
settings set <key> <value>  Set a general setting, theme, keybinding.* or ui.*
  $ bb settings set steerActiveThreadOnEnter false
  $ bb settings set theme nord
  $ bb settings set keybinding.thread.new mod+shift+n
settings reset <key>  Restore one setting to its default

plugin list  List plugins, their state and the commands they add
  > {plugins: [{id, name, enabled, status, cliCommands, …}]}
plugin enable <id>  Enable a plugin
plugin disable <id>  Disable a plugin
plugin reload [id]  Reload one plugin, or rediscover and reload all of them
plugin add <path>  Load a plugin directory (adds it to <dataDir>/config.json)
plugin remove <path>  Stop loading a plugin directory
${YES}
plugin config <id> [action] [key] [value]  Show or change a plugin's settings
  --project <id>  Read or write the value for one project
  $ bb plugin config marketplace
  $ bb plugin config marketplace set catalogs ./catalog.json
  $ bb plugin config github unset token
  > {ok, schema: {<key>: {type, label, …}}, values: {<key>: value}}

server  Run the bb server in the foreground
server status  Check that the server answers and show its data directory
import-legacy  Copy projects, sections, settings and threads from an old bb
  --from <dir>  Data directory of the original install; it is only read
  --threads <which>  active (unarchived threads and their families), all, none
  --dry-run  Only count what each --threads choice would import
  $ bb import-legacy --from ~/.bb --dry-run
  > {dryRun, dataDir, choices, counts: {<table>: {imported, skipped}}, …}
runner join <blob>  Enrol this machine with the command bb machine add printed
  --header <name=value>...  Header sent on every request to the server
  --reuse-connect-credential [path]  Reuse an old install's connect credential
  --data-dir <dir>  Where to keep runner.json
  --name <name>  Machine name (default: the hostname)
runner run  Run this machine's runner in the foreground
  --data-dir <dir>  Directory that bb runner join wrote
`;

export const handlers = {
  ...people,
  ...system,
  ...thread,
  ...threadMore,
  ...workspace,
  ...terminal,
};

export const table: Table = {
  commands: parseCommands(COMMANDS, handlers),
  groups: {
    thread: "Create, message, wait on and read threads",
    "thread interactions": "Approvals, questions and plugin forms of a thread",
    "thread queue": "Messages waiting to be sent to a thread",
    "thread section": "Sidebar sections",
    project: "Projects and the directories that hold them on each machine",
    "project source": "Where a project lives on a machine",
    "project attachment": "Files attached to prompts",
    env: "Environments: the checkouts and worktrees threads run in",
    machine: "Machines that run threads",
    "machine env": "Environment variables given to agents",
    user: "People who can sign in, their invites and sign-in links",
    provider: "Agent providers and their models",
    terminal: "Terminals in a thread, an environment or on a machine",
    file: "Read and write files on any machine",
    settings: "General settings, theme, keybindings and UI preferences",
    plugin: "Plugins and the commands they add",
    runner: "Join this machine to a server and run its runner",
  },
  aliases: {
    threads: "thread",
    logs: "thread log",
    section: "thread section",
    sections: "thread section",
    projects: "project",
    environment: "env",
    environments: "env",
    envs: "env",
    host: "machine",
    hosts: "machine",
    machines: "machine",
    users: "user",
    people: "user",
    invite: "user invite",
    providers: "provider",
    model: "provider models",
    models: "provider models",
    agent: "provider list",
    agents: "provider list",
    terminals: "terminal",
    config: "settings",
    plugins: "plugin",
  },
};
