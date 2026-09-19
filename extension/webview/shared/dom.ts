// Tiny DOM helpers. File content only ever reaches the page through textContent.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, string | number | boolean | ((e: Event) => void)>> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === false) { continue; }
        if (typeof value === 'function') {
            el.addEventListener(key.replace(/^on/, '').toLowerCase(), value as EventListener);
        } else if (key === 'className') {
            el.className = String(value);
        } else if (key === 'style') {
            // CSSOM, not the style attribute, which the webview's CSP blocks
            el.style.cssText = String(value);
        } else if (key === 'text') {
            el.textContent = String(value);
        } else if (value === true) {
            el.setAttribute(key, '');
        } else {
            el.setAttribute(key, String(value));
        }
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) { continue; }
        el.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) { el.setAttribute(key, String(value)); }
    if (text !== undefined) { el.textContent = text; }
    return el;
}

export function formatCount(n: number): string {
    return n.toLocaleString('en-US');
}

export function formatMs(ms: number): string {
    if (ms < 1000) { return `${Math.max(1, Math.round(ms))} ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`; }
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)} min ${s % 60} s`;
}
