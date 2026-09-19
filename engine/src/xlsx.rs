//! Lists the sheets of an .xlsx workbook. DuckDB's Excel extension reads one
//! sheet at a time but can't list them, so we read `xl/workbook.xml` ourselves.

use std::fs::File;
use std::io::Read;

pub fn sheet_names(path: &str) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("Can't open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "This file isn't a valid .xlsx workbook.".to_string())?;
    let mut xml = String::new();
    archive
        .by_name("xl/workbook.xml")
        .map_err(|_| "This workbook has no sheet list (xl/workbook.xml is missing).".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Can't read the workbook's sheet list: {e}"))?;
    Ok(parse_sheet_names(&xml))
}

fn parse_sheet_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = xml;
    while let Some(start) = find_tag(rest, "sheet") {
        let tag = &rest[start..];
        let end = tag.find('>').unwrap_or(tag.len());
        if let Some(name) = attribute(&tag[..end], "name") {
            names.push(unescape(name));
        }
        rest = &tag[end..];
    }
    names
}

/// Start of the next `<sheet ` or `<x:sheet ` element, skipping `<sheets>`.
fn find_tag(xml: &str, tag: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = xml[from..].find('<') {
        let at = from + i;
        let name_end = xml[at + 1..]
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .map(|n| at + 1 + n)?;
        let name = &xml[at + 1..name_end];
        if name == tag || name.rsplit(':').next() == Some(tag) {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = tag;
    while let Some(i) = rest.find(name) {
        let before = rest[..i].chars().last();
        let after = &rest[i + name.len()..];
        if matches!(before, Some(c) if c.is_whitespace()) {
            let after = after.trim_start();
            if let Some(value) = after.strip_prefix('=') {
                let value = value.trim_start();
                let quote = value.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let value = &value[1..];
                    return value.find(quote).map(|end| &value[..end]);
                }
            }
        }
        rest = &rest[i + name.len()..];
    }
    None
}

fn unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
