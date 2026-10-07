fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = bb_cli::run(&argv, |name| std::env::var(name).ok());
    std::process::exit(code);
}
