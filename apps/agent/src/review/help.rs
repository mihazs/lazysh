//! The help of `review` in English, Brazilian Portuguese and Spanish, chosen like a POSIX program
//! does: the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set. Everything else the binary
//! prints, including the usage errors of the parser, stays English, and so does the review output,
//! which is Git's own short status format and unified patch.
use clap::{Arg, ArgAction, Command};

struct Text {
    usage: &'static str,
    commands: &'static str,
    arguments: &'static str,
    options: &'static str,
    help: &'static str,
    directory_name: &'static str,
    file_name: &'static str,
    review: &'static str,
    status: &'static str,
    diff: &'static str,
    directory: &'static str,
    file: &'static str,
    staged: &'static str,
    json: &'static str,
}

const ENGLISH: Text = Text {
    usage: "Usage:",
    commands: "Commands",
    arguments: "Arguments",
    options: "Options",
    help: "Print help",
    directory_name: "DIRECTORY",
    file_name: "FILE",
    review: "Review a repository from the terminal: its changed files and the diff of one file. Read-only.",
    status: "List the changed files of the repository that contains the directory: staged, unstaged, untracked and renamed.",
    diff: "Print the patch of one changed file of the repository that contains the directory.",
    directory: "A directory inside the repository.",
    file: "The file, as a path relative to the repository root.",
    staged: "Read the staged changes instead of the unstaged ones.",
    json: "Print one JSON line instead of plain text.",
};

const PORTUGUESE: Text = Text {
    usage: "Uso:",
    commands: "Comandos",
    arguments: "Argumentos",
    options: "Opções",
    help: "Mostra a ajuda",
    directory_name: "DIRETÓRIO",
    file_name: "ARQUIVO",
    review: "Revisa um repositório pelo terminal: os arquivos alterados e o diff de um arquivo. Somente leitura.",
    status: "Lista os arquivos alterados do repositório que contém o diretório: preparados, não preparados, não rastreados e renomeados.",
    diff: "Imprime o patch de um arquivo alterado do repositório que contém o diretório.",
    directory: "Um diretório dentro do repositório.",
    file: "O arquivo, como caminho relativo à raiz do repositório.",
    staged: "Lê as alterações preparadas em vez das não preparadas.",
    json: "Imprime uma linha JSON em vez de texto simples.",
};

const SPANISH: Text = Text {
    usage: "Uso:",
    commands: "Comandos",
    arguments: "Argumentos",
    options: "Opciones",
    help: "Muestra la ayuda",
    directory_name: "DIRECTORIO",
    file_name: "ARCHIVO",
    review: "Revisa un repositorio desde la terminal: sus archivos modificados y el diff de un archivo. Solo lectura.",
    status: "Lista los archivos modificados del repositorio que contiene el directorio: preparados, sin preparar, sin seguimiento y renombrados.",
    diff: "Imprime el parche de un archivo modificado del repositorio que contiene el directorio.",
    directory: "Un directorio dentro del repositorio.",
    file: "El archivo, como ruta relativa a la raíz del repositorio.",
    staged: "Lee los cambios preparados en lugar de los no preparados.",
    json: "Imprime una línea JSON en lugar de texto plano.",
};

/// The first of the POSIX locale variables that is set and not empty.
pub fn locale_from_environment() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

fn text(locale: Option<&str>) -> &'static Text {
    let language = locale
        .and_then(|locale| locale.split(['_', '-', '.', '@']).next())
        .map(str::to_ascii_lowercase);
    match language.as_deref() {
        Some("pt") => &PORTUGUESE,
        Some("es") => &SPANISH,
        _ => &ENGLISH,
    }
}

/// Own the help of one command: its usage heading, the help flag and the headings of its arguments.
fn page(command: Command, text: &Text, about: &'static str) -> Command {
    command
        .about(about)
        .disable_help_flag(true)
        .disable_help_subcommand(true)
        .subcommand_help_heading(text.commands)
        .help_template(format!(
            "{{about}}\n\n{} {{usage}}\n\n{{all-args}}",
            text.usage
        ))
        .arg(
            Arg::new("help")
                .short('h')
                .long("help")
                .action(ArgAction::Help)
                .help(text.help)
                .help_heading(text.options),
        )
}

fn positional(
    command: Command,
    id: &str,
    name: &'static str,
    help: &'static str,
    text: &Text,
) -> Command {
    command.mut_arg(id, |arg| {
        arg.value_name(name).help(help).help_heading(text.arguments)
    })
}

fn flag(command: Command, id: &str, help: &'static str, text: &Text) -> Command {
    command.mut_arg(id, |arg| arg.help(help).help_heading(text.options))
}

/// `command` with the help of its `review` subcommand written in the language of `locale`.
pub fn localize(command: Command, locale: Option<&str>) -> Command {
    let text = text(locale);
    command.mut_subcommand("review", |review| {
        flag(page(review, text, text.review), "json", text.json, text)
            .mut_subcommand("status", |status| {
                let status = page(status, text, text.status);
                positional(
                    status,
                    "directory",
                    text.directory_name,
                    text.directory,
                    text,
                )
            })
            .mut_subcommand("diff", |diff| {
                let diff = page(diff, text, text.diff);
                let diff = positional(diff, "directory", text.directory_name, text.directory, text);
                let diff = positional(diff, "file", text.file_name, text.file, text);
                flag(diff, "staged", text.staged, text)
            })
    })
}
