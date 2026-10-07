use bb_server::plugins::api::{CliCommandSummary, CliContext, CliResult};
use bb_server::plugins::cli::{
    CliCommand, CliInput, CliOption, CliOutcome, CliPositional, CliSpec, PluginCliError,
    cli_output, define_cli,
};
use serde_json::{Value, json};

async fn echo(input: CliInput, _context: CliContext) -> CliOutcome {
    let body = json!({ "options": input.options, "positionals": input.positionals });
    cli_output(format!("{body}\n"))
}

fn item_list() -> CliCommand {
    CliCommand::new("List items", echo)
        .option("json", CliOption::boolean("Print JSON"))
        .option("filter", CliOption::string("Filter text"))
}

fn demo() -> CliSpec {
    CliSpec::new("demo", "Demo plugin commands")
        .root(
            CliCommand::new("Show the status", echo)
                .positional(CliPositional::new("target", "What to show"))
                .option("verbose", CliOption::boolean("More output").alias("v")),
        )
        .command(
            "add",
            CliCommand::new("Add items", echo)
                .description("Adds one or more items to the list.")
                .alias("new")
                .alias("create item")
                .positional(CliPositional::new("name", "Item name").required())
                .positional(CliPositional::new("tags", "Extra tags").variadic())
                .option("count", CliOption::integer("How many").default_value(1))
                .option("kind", CliOption::enumeration(["a", "b", "c"], "Item kind").required())
                .option(
                    "label",
                    CliOption::string("Labels").repeatable().placeholder("text").alias("l"),
                )
                .option("force", CliOption::boolean("Overwrite"))
                .option("json", CliOption::boolean("Print JSON"))
                .option("size", CliOption::integer("Sizes").repeatable()),
        )
        .command("item list", item_list())
        .command(
            "item remove",
            CliCommand::new("Remove an item", |input: CliInput, _| async move {
                match input.positional("id") {
                    Some("boom") => Err(PluginCliError::new("could not remove")
                        .code("not_found")
                        .hint("Check the id.")),
                    Some("bare") => Err(PluginCliError::new("plain failure").exit_code(3)),
                    _ => cli_output(input.help),
                }
            })
            .positional(CliPositional::new("id", "Item id").required())
            .option("json", CliOption::boolean("Print JSON")),
        )
}

#[tokio::test]
async fn matches_the_typescript_reference() {
    let reference: Value =
        serde_json::from_str(include_str!("fixtures/plugin_cli/reference.json")).unwrap();
    let demo = define_cli(demo());
    let bare = define_cli(CliSpec::new("bare", "No root").command("go", item_list()));
    let commands: Vec<CliCommandSummary> =
        serde_json::from_value(reference["commands"].clone()).unwrap();
    assert_eq!(demo.commands(), commands);
    assert_eq!(demo.name(), "demo");
    for case in reference["cases"].as_array().unwrap() {
        let argv: Vec<String> = serde_json::from_value(case["argv"].clone()).unwrap();
        let expected: CliResult = serde_json::from_value(case["result"].clone()).unwrap();
        let cli = if case["cli"] == "demo" { &demo } else { &bare };
        let actual = cli.run(argv.clone(), CliContext::default()).await;
        assert_eq!(actual, expected, "{} {argv:?}", case["cli"]);
    }
}

#[tokio::test]
async fn typed_accessors_read_parsed_values() {
    let cli = define_cli(
        CliSpec::new("t", "T").command(
            "go",
            CliCommand::new("Go", |input: CliInput, _| async move {
                let line = format!(
                    "{}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
                    input.flag("force"),
                    input.string("kind"),
                    input.integer("count"),
                    input.strings("label"),
                    input.integers("size"),
                    input.positional("name"),
                    input.variadic("rest"),
                );
                cli_output(line)
            })
            .positional(CliPositional::new("name", "Name"))
            .positional(CliPositional::new("rest", "Rest").variadic())
            .option("force", CliOption::boolean("F"))
            .option("kind", CliOption::enumeration(["x"], "K"))
            .option("count", CliOption::integer("C").default_value(5))
            .option("label", CliOption::string("L").repeatable())
            .option("size", CliOption::integer("S").repeatable()),
        ),
    );
    let argv = ["go", "n", "r1", "r2", "--force", "--kind=x", "--label", "a", "--size", "-2"];
    let result = cli.run(argv.map(String::from).to_vec(), CliContext::default()).await;
    assert_eq!(result.stdout, r#"true|Some("x")|Some(5)|["a"]|[-2]|Some("n")|["r1", "r2"]"#);
}
