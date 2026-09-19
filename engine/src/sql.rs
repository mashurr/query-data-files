//! Small SQL helpers: quoting, trimming user input and refusing statements
//! that would download or load DuckDB extensions.

pub fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Lowercase identifier made of letters, digits and underscores, never starting with a digit.
pub fn safe_name(value: &str) -> String {
    let mut out: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

/// Drops leading and trailing whitespace, comments and semicolons so the
/// statement can be wrapped in `CREATE TABLE ... AS`.
pub fn trim_statement(sql: &str) -> &str {
    let mut s = sql.trim();
    loop {
        let before = s.len();
        s = s.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
        if let Some(last_line_start) = s.rfind('\n').map(|i| i + 1).or(Some(0)) {
            let last_line = &s[last_line_start..];
            if let Some(pos) = find_line_comment(last_line) {
                s = &s[..last_line_start + pos];
            }
        }
        if s.len() == before {
            return s;
        }
    }
}

/// Position of a `--` comment on a line, ignoring `--` inside string literals or quoted identifiers.
fn find_line_comment(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'\'' || b == b'"' => quote = Some(b),
            None if b == b'-' && bytes.get(i + 1) == Some(&b'-') => return Some(i),
            None => {}
        }
        i += 1;
    }
    None
}

/// First keywords of a statement, uppercased, skipping whitespace, comments and opening parentheses.
pub fn leading_keywords(sql: &str, count: usize) -> Vec<String> {
    let mut words = Vec::new();
    let mut s = sql;
    while words.len() < count {
        let trimmed = s.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
        if let Some(rest) = trimmed.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = trimmed.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            let word: String = trimmed
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .collect();
            if word.is_empty() {
                break;
            }
            s = &trimmed[word.len()..];
            words.push(word.to_ascii_uppercase());
        }
    }
    words
}

/// Statements people may not run from the extension: they would download or load
/// DuckDB extensions, which the bundled engine keeps fixed.
pub fn check_user_statement(sql: &str) -> Result<(), String> {
    let words = leading_keywords(sql, 2);
    let first = words.first().map_or("", String::as_str);
    let second = words.get(1).map_or("", String::as_str);
    match (first, second) {
        ("INSTALL" | "LOAD" | "FORCE", _) | ("UPDATE", "EXTENSIONS") => Err(
            "Installing or loading DuckDB extensions isn't available here. Query Data Files ships with the SQLite and Excel extensions already loaded."
                .into(),
        ),
        ("", _) => Err("The query is empty.".into()),
        _ => Ok(()),
    }
}
