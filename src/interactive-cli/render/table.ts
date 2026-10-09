import { ansi, stripAnsi, box } from './ansi.js';

export interface TableOptions {
  maxWidth?: number;
}

export function renderTable(headers: string[], rows: string[][], options?: TableOptions): string {
  const allRows = [headers, ...rows];
  const colWidths = headers.map((_, i) =>
    Math.max(...allRows.map((row) => stripAnsi(row[i] || '').length)),
  );

  const renderBorder = (left: string, mid: string, right: string, char: string) => {
    return left + colWidths.map((w) => char.repeat(w + 2)).join(mid) + right;
  };

  const topBorder = renderBorder(box.topLeft, box.tDown, box.topRight, box.horizontal);
  const midBorder = renderBorder(box.tRight, box.cross, box.tLeft, box.horizontal);
  const bottomBorder = renderBorder(box.bottomLeft, box.tUp, box.bottomRight, box.horizontal);

  const renderRow = (row: string[], isHeader = false) => {
    const cells = row.map((cell, i) => {
      const stripped = stripAnsi(cell);
      const width = colWidths[i] ?? 0;
      const padding = ' '.repeat(Math.max(0, width - stripped.length));
      const content = isHeader ? ansi.bold(ansi.cyan(cell)) : cell;
      return ` ${content}${padding} `;
    });
    return `${box.vertical}${cells.join(box.vertical)}${box.vertical}`;
  };

  const output = [];
  output.push(topBorder);
  output.push(renderRow(headers, true));
  output.push(midBorder);
  rows.forEach((row) => {
    output.push(renderRow(row));
  });
  output.push(bottomBorder);

  return output.join('\n');
}
