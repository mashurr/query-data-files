// A virtual grid: only the rows and columns on screen exist in the DOM. Rows come
// from the engine a page at a time as you scroll.

import { DataType, Type } from '@uwdata/flechette';
import { Column } from '../../src/shared/protocol';
import { h } from '../shared/dom';
import { closeMenu } from '../shared/menu';
import { Decoded, formatValue, isNumericType } from '../shared/values';
import { Profile, renderProfile } from './profile';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 38;
const PROFILE_HEIGHT = 36;
const NUMBER_WIDTH = 64;
const MIN_WIDTH = 48;
const MIN_PROFILE_WIDTH = 104;
const MAX_AUTO_WIDTH = 360;
export const PAGE_ROWS = 200;
const OVERSCAN_ROWS = 12;
const OVERSCAN_PX = 300;
const MAX_PAINTED_ROWS = 400;
const PAINT_FALLBACK_MS = 100;
// Browsers can't scroll an element taller than about 33 million pixels (1.5 million rows).
// Past this height the scrollbar position maps proportionally onto the rows instead.
const MAX_BODY_PX = 8_000_000;

export interface GridData {
    columns: Column[];
    types: DataType[];
    rows: number;
    first: Decoded;
    /** Omitted when every row is already in `first` */
    fetch?: (offset: number) => Promise<Decoded | undefined>;
    /** This many leading columns carry data for `decorate` and aren't shown */
    hidden?: number;
    /** Room for two values per cell, e.g. an old and a new one */
    wide?: boolean;
    /** Styles a row and its cells after they're filled, e.g. to mark changes */
    decorate?: (row: HTMLElement, cells: Map<number, HTMLElement>, value: (column: number) => unknown) => void;
}

export interface CellRef {
    row: number;
    column: number;
    value: unknown;
}

export interface GridActions {
    headerClick(column: number): void;
    headerMenu(column: number, x: number, y: number): void;
    cellMenu(cell: CellRef, x: number, y: number): void;
    copyCell(cell: CellRef): void;
}

type Page = { columns: unknown[][] } | 'loading' | 'failed';

export class Grid {
    private data: GridData | undefined;
    private widths: number[] = [];
    private offsets: number[] = [];
    private readonly pages = new Map<number, Page>();
    private profiles: (Profile | undefined)[] = [];
    private sort: { column: number; descending: boolean } | undefined;
    private selected: { row: number; column: number } | undefined;
    private frame = 0;
    private fallback = 0;
    private generation = 0;
    private readonly header: HTMLElement;
    private readonly body: HTMLElement;
    private readonly sizer: HTMLElement;
    private showProfiles = true;
    private measuredChar = 0;

    constructor(private readonly scroller: HTMLElement, private readonly actions: GridActions) {
        scroller.classList.add('grid');
        scroller.tabIndex = 0;
        scroller.setAttribute('role', 'grid');
        this.sizer = h('div', { className: 'grid-sizer' });
        this.header = h('div', { className: 'grid-header', role: 'row' });
        this.body = h('div', { className: 'grid-body', role: 'rowgroup' });
        this.sizer.append(this.header, this.body);
        scroller.append(this.sizer);
        scroller.addEventListener('scroll', () => { closeMenu(); this.schedule(); });
        new ResizeObserver(() => this.schedule()).observe(scroller);
        this.body.addEventListener('mousedown', e => this.clickCell(e));
        this.body.addEventListener('contextmenu', e => this.cellContext(e));
        this.header.addEventListener('contextmenu', e => {
            const col = this.headerColumn(e.target);
            if (col === undefined) { return; }
            e.preventDefault();
            this.actions.headerMenu(col, e.clientX, e.clientY);
        });
        scroller.addEventListener('keydown', e => this.key(e));
    }

    get rowCount(): number { return this.data?.rows ?? 0; }

    setData(data: GridData, keepLayout = false) {
        const sameColumns = keepLayout && this.data
            && this.data.columns.length === data.columns.length
            && this.data.columns.every((c, i) => c.name === data.columns[i].name);
        this.data = data;
        this.generation++;
        this.pages.clear();
        this.pages.set(0, { columns: data.first.columns });
        if (!sameColumns) {
            this.widths = data.columns.map((c, i) => i < (data.hidden ?? 0) ? 0
                : Math.min(MAX_AUTO_WIDTH, this.autoWidth(c, data.types[i], data.first.columns[i] ?? []) * (data.wide ? 1.8 : 1)));
            this.profiles = [];
            this.selected = undefined;
            this.scroller.scrollTop = 0;
            this.scroller.scrollLeft = 0;
        }
        this.layout();
    }

    clear() {
        this.data = undefined;
        this.generation++;
        this.pages.clear();
        this.layout();
    }

    setSort(column: number | undefined, descending: boolean) {
        this.sort = column === undefined ? undefined : { column, descending };
        this.paintHeader();
    }

    setProfiles(profiles: (Profile | undefined)[]) {
        this.profiles = profiles;
        this.paintHeader();
    }

    setProfilesVisible(visible: boolean) {
        this.showProfiles = visible;
        this.layout();
    }

    /** Width of one character in the editor font the cells use */
    private charWidth(): number {
        if (!this.measuredChar) {
            const probe = h('div', { className: 'cell', style: 'position:absolute;visibility:hidden;width:auto' }, '0'.repeat(20));
            this.body.append(probe);
            this.measuredChar = probe.getBoundingClientRect().width / 20 || 8;
            probe.remove();
        }
        return this.measuredChar;
    }

    private autoWidth(column: Column, type: DataType, sample: unknown[]): number {
        const char = this.charWidth();
        let text = column.name.length * 1.1 + 2;
        for (let i = 0; i < Math.min(sample.length, 50); i++) {
            text = Math.max(text, formatValue(sample[i], type).length);
        }
        const floor = this.showProfiles ? MIN_PROFILE_WIDTH : MIN_WIDTH + 30;
        return Math.round(Math.min(MAX_AUTO_WIDTH, Math.max(floor, text * char + 16)));
    }

    private headerHeight(): number {
        return HEADER_HEIGHT + (this.showProfiles ? PROFILE_HEIGHT : 0);
    }

    private layout() {
        this.offsets = [];
        let x = NUMBER_WIDTH;
        for (const w of this.widths) { this.offsets.push(x); x += w; }
        const rows = this.data?.rows ?? 0;
        this.sizer.style.width = `${x}px`;
        this.sizer.style.height = `${this.headerHeight() + this.bodyHeight()}px`;
        this.header.style.height = `${this.headerHeight()}px`;
        this.body.style.top = `${this.headerHeight()}px`;
        this.body.style.height = `${this.bodyHeight()}px`;
        this.schedule();
    }

    private bodyHeight(): number {
        return Math.min((this.data?.rows ?? 0) * ROW_HEIGHT, MAX_BODY_PX);
    }

    private scaled(): boolean {
        return (this.data?.rows ?? 0) * ROW_HEIGHT > MAX_BODY_PX;
    }

    /** Rows that fit on screen, and how far the body can scroll */
    private viewport() {
        const visible = Math.max(1, Math.floor((this.scroller.clientHeight - this.headerHeight()) / ROW_HEIGHT));
        const maxScroll = Math.max(1, this.bodyHeight() - (this.scroller.clientHeight - this.headerHeight()));
        return { visible, maxScroll };
    }

    /** The (fractional) row at the top of the screen */
    private topRow(): number {
        const top = Math.max(0, this.scroller.scrollTop);
        if (!this.scaled()) { return top / ROW_HEIGHT; }
        const { visible, maxScroll } = this.viewport();
        return Math.min(1, top / maxScroll) * Math.max(0, (this.data?.rows ?? 0) - visible);
    }

    private rowY(row: number): number {
        return this.scaled() ? Math.max(0, this.scroller.scrollTop) + (row - this.topRow()) * ROW_HEIGHT : row * ROW_HEIGHT;
    }

    private scrollToRow(row: number) {
        if (!this.scaled()) { this.scroller.scrollTop = row * ROW_HEIGHT; return; }
        const { visible, maxScroll } = this.viewport();
        this.scroller.scrollTop = row / Math.max(1, (this.data?.rows ?? 0) - visible) * maxScroll;
    }

    /** Paints on the next frame, or after a moment if frames are paused (a window the browser thinks is hidden) */
    private schedule() {
        if (this.frame) { return; }
        const run = () => {
            if (!this.frame) { return; }
            cancelAnimationFrame(this.frame);
            clearTimeout(this.fallback);
            this.frame = 0;
            this.paint();
        };
        this.frame = requestAnimationFrame(run);
        this.fallback = window.setTimeout(run, PAINT_FALLBACK_MS);
    }

    private visibleColumns(): number[] {
        const left = this.scroller.scrollLeft - OVERSCAN_PX;
        const right = this.scroller.scrollLeft + this.scroller.clientWidth + OVERSCAN_PX;
        const out: number[] = [];
        for (let i = 0; i < this.widths.length; i++) {
            if (this.widths[i] && this.offsets[i] + this.widths[i] >= left && this.offsets[i] <= right) { out.push(i); }
        }
        return out;
    }

    private paint() {
        this.paintHeader();
        this.paintBody();
    }

    private paintHeader() {
        const data = this.data;
        if (!data) { this.header.replaceChildren(); return; }
        const cells: HTMLElement[] = [h('div', { className: 'hcell number', style: `width:${NUMBER_WIDTH}px` }, '#')];
        for (const i of this.visibleColumns()) {
            const col = data.columns[i];
            const sorted = this.sort?.column === i ? (this.sort.descending ? ' ↓' : ' ↑') : '';
            const title = h('button', { className: 'hname', title: `${col.name} (${col.type}). Click to sort, right-click for more.` },
                h('span', { className: 'name', text: col.name }),
                h('span', { className: 'sort', text: sorted }));
            // Mouse sorting fires on press: the header can redraw (profiles arriving) before the release,
            // which would swallow a click. Enter and Space still work through click.
            title.addEventListener('mousedown', e => { if (e.button === 0) { e.preventDefault(); this.actions.headerClick(i); } });
            title.addEventListener('click', e => { if (e.detail === 0) { this.actions.headerClick(i); } });
            const cell = h('div', {
                className: `hcell${isNumericType(data.types[i]) ? ' numeric' : ''}`,
                role: 'columnheader', 'data-col': i,
                style: `left:${this.offsets[i]}px;width:${this.widths[i]}px`,
            }, title, h('span', { className: 'htype', text: col.type }));
            if (this.showProfiles) { cell.append(renderProfile(this.profiles[i], this.widths[i])); }
            const grip = h('span', { className: 'resize', title: 'Drag to resize' });
            grip.addEventListener('mousedown', e => this.startResize(e, i));
            grip.addEventListener('dblclick', () => this.fitColumn(i));
            cell.append(grip);
            cells.push(cell);
        }
        this.header.replaceChildren(...cells);
    }

    private paintBody() {
        const data = this.data;
        if (!data) { this.body.replaceChildren(); return; }
        const topRow = this.topRow();
        const first = Math.max(0, Math.floor(topRow) - OVERSCAN_ROWS);
        // Capped in case the grid's box isn't sized yet and reports its full content height
        const last = Math.min(data.rows, Math.ceil(topRow + this.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN_ROWS, first + MAX_PAINTED_ROWS);
        const columns = this.visibleColumns();
        const rows: HTMLElement[] = [];
        for (let r = first; r < last; r++) {
            const page = this.page(r);
            const row = h('div', { className: 'row', role: 'row', 'data-row': r, style: `top:${this.rowY(r)}px` },
                h('div', { className: 'cell number', text: (r + 1).toLocaleString('en-US') }));
            const cells = new Map<number, HTMLElement>();
            for (const c of columns) {
                const cell = h('div', {
                    className: 'cell', role: 'gridcell', 'data-col': c,
                    style: `left:${this.offsets[c]}px;width:${this.widths[c]}px`,
                });
                if (typeof page === 'object') {
                    const value = page.columns[c]?.[r % PAGE_ROWS];
                    this.fillCell(cell, value, data.types[c]);
                } else {
                    cell.classList.add('pending');
                    if (page === 'failed') { cell.textContent = '—'; }
                }
                if (this.selected?.row === r && this.selected.column === c) { cell.classList.add('selected'); }
                row.append(cell);
                cells.set(c, cell);
            }
            if (data.decorate && typeof page === 'object') {
                data.decorate(row, cells, column => page.columns[column]?.[r % PAGE_ROWS]);
            }
            rows.push(row);
        }
        this.body.replaceChildren(...rows);
    }

    private fillCell(cell: HTMLElement, value: unknown, type: DataType) {
        if (value === null || value === undefined) {
            cell.classList.add('null');
            cell.textContent = 'NULL';
            return;
        }
        const text = formatValue(value, type);
        cell.textContent = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
        if (isNumericType(type)) { cell.classList.add('numeric'); }
        if (type.typeId === Type.Bool) { cell.classList.add('bool'); }
        if (text.length * this.charWidth() > (parseFloat(cell.style.width) || 0) - 12) { cell.title = text.slice(0, 4000); }
    }

    /** The page a row is on, starting a fetch when it isn't loaded yet */
    private page(row: number): Page | undefined {
        const index = Math.floor(row / PAGE_ROWS);
        const page = this.pages.get(index);
        if (page) { return page; }
        const fetch = this.data?.fetch;
        if (!fetch) { return 'failed'; }
        this.pages.set(index, 'loading');
        const generation = this.generation;
        fetch(index * PAGE_ROWS).then(decoded => {
            if (generation !== this.generation) { return; }
            this.pages.set(index, decoded ? { columns: decoded.columns } : 'failed');
            this.schedule();
        });
        return 'loading';
    }

    private cellAt(target: EventTarget | null): CellRef | undefined {
        const cell = (target as HTMLElement | null)?.closest?.('.cell[data-col]') as HTMLElement | null;
        const row = cell?.parentElement as HTMLElement | null;
        if (!cell || !row) { return undefined; }
        const r = Number(row.dataset.row), c = Number(cell.dataset.col);
        const page = this.pages.get(Math.floor(r / PAGE_ROWS));
        if (typeof page !== 'object') { return undefined; }
        return { row: r, column: c, value: page.columns[c]?.[r % PAGE_ROWS] };
    }

    private headerColumn(target: EventTarget | null): number | undefined {
        const cell = (target as HTMLElement | null)?.closest?.('.hcell[data-col]') as HTMLElement | null;
        return cell ? Number(cell.dataset.col) : undefined;
    }

    private clickCell(e: MouseEvent) {
        const cell = this.cellAt(e.target);
        if (!cell) { return; }
        this.selected = { row: cell.row, column: cell.column };
        this.schedule();
    }

    private cellContext(e: MouseEvent) {
        const cell = this.cellAt(e.target);
        if (!cell) { return; }
        e.preventDefault();
        this.selected = { row: cell.row, column: cell.column };
        this.schedule();
        this.actions.cellMenu(cell, e.clientX, e.clientY);
    }

    private key(e: KeyboardEvent) {
        if (!this.selected || !this.data) { return; }
        let { row, column } = this.selected;
        switch (e.key) {
            case 'ArrowDown': row = Math.min(this.data.rows - 1, row + 1); break;
            case 'ArrowUp': row = Math.max(0, row - 1); break;
            case 'ArrowRight': column = Math.min(this.data.columns.length - 1, column + 1); break;
            case 'ArrowLeft': column = Math.max(0, column - 1); break;
            case 'PageDown': row = Math.min(this.data.rows - 1, row + Math.floor(this.scroller.clientHeight / ROW_HEIGHT)); break;
            case 'PageUp': row = Math.max(0, row - Math.floor(this.scroller.clientHeight / ROW_HEIGHT)); break;
            case 'c':
                if (e.ctrlKey || e.metaKey) {
                    const page = this.pages.get(Math.floor(row / PAGE_ROWS));
                    if (typeof page === 'object') {
                        this.actions.copyCell({ row, column, value: page.columns[column]?.[row % PAGE_ROWS] });
                    }
                    e.preventDefault();
                }
                return;
            default: return;
        }
        e.preventDefault();
        this.selected = { row, column };
        this.reveal(row, column);
        this.schedule();
    }

    private reveal(row: number, column: number) {
        const s = this.scroller;
        const { visible } = this.viewport();
        const topRow = this.topRow();
        if (row < topRow) { this.scrollToRow(row); }
        if (row >= topRow + visible) { this.scrollToRow(row - visible + 1); }
        const left = this.offsets[column], right = left + this.widths[column];
        if (left - NUMBER_WIDTH < s.scrollLeft) { s.scrollLeft = left - NUMBER_WIDTH; }
        if (right > s.scrollLeft + s.clientWidth) { s.scrollLeft = right - s.clientWidth; }
    }

    private startResize(e: MouseEvent, column: number) {
        e.preventDefault();
        e.stopPropagation();
        const start = e.clientX, width = this.widths[column];
        const move = (ev: MouseEvent) => {
            this.widths[column] = Math.max(MIN_WIDTH, width + ev.clientX - start);
            this.layout();
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    private fitColumn(column: number) {
        const data = this.data;
        if (!data) { return; }
        const loaded: unknown[] = [];
        for (const page of this.pages.values()) {
            if (typeof page === 'object') { loaded.push(...(page.columns[column] ?? []).slice(0, 500)); }
        }
        this.widths[column] = this.autoWidth(data.columns[column], data.types[column], loaded);
        this.layout();
    }
}
