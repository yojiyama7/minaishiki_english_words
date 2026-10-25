"""Reference implementation of the unit crop detection, used to validate it on a whole book.

The web app runs the same algorithm (src/lib/crop-layout.ts) in the browser on the user's PDF.
This script only prints statistics and writes review sheets; the PDF is never committed.

Usage: python3 scripts/detect-crops.py <book.pdf> <unit-1 page (1-based)> [--sheets <dir>] [--json <file>]
Requires: pymupdf, numpy, pillow
"""

import io
import json
import sys
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw

UNIT_COUNT = 232
INK = 150  # min(R, G, B) below this is printed ink (black or pink)
PAPER = 240  # a row whose middle has a median below this is the gray ANSWERS panel


def runs(mask, close=0):
    """[start, end] index ranges of True values, bridging gaps of at most `close`."""
    out = []
    for i in np.flatnonzero(mask):
        if out and i - out[-1][1] <= close + 1:
            out[-1][1] = int(i)
        else:
            out.append([int(i), int(i)])
    return out


def page_rgb(doc, index):
    page = doc[index]
    xref = page.get_images(full=True)[0][0]
    image = Image.open(io.BytesIO(doc.extract_image(xref)["image"])).convert("RGB")
    return image, np.asarray(image, dtype=np.int16)


def longest_runs(mask):
    """Length of the longest horizontal run of True in each row."""
    padded = np.zeros((mask.shape[0], mask.shape[1] + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    out = np.zeros(mask.shape[0], dtype=np.int64)
    for y, row in enumerate(np.diff(padded, axis=1)):
        starts, ends = np.flatnonzero(row == 1), np.flatnonzero(row == -1)
        if len(starts):
            out[y] = (ends - starts).max()
    return out


def find_panels(gray, ink, side):
    h, w = gray.shape
    if side == "A":
        middle = np.median(gray[:, int(w * 0.2) : int(w * 0.8)], axis=1)
        return [r for r in runs(middle < PAPER, close=6) if r[1] - r[0] > h * 0.05]
    panels = []
    for start, end in runs(ink.any(axis=1), close=2):
        if end - start < h * 0.05:
            continue
        # The vocabulary box has left and right borders: a column on each side is inked on nearly
        # every row. Columns are widened by a few pixels so a slightly tilted border still counts.
        band = ink[start : end + 1]
        widened = band.copy()
        for shift in range(1, 7):
            widened[:, :-shift] |= band[:, shift:]
        coverage = widened.mean(axis=0)
        if coverage[: int(w * 0.3)].max() > 0.8 and coverage[int(w * 0.7) :].max() > 0.8:
            panels.append([start, end])
    return panels


def analyse(rgb, side):
    gray = rgb.min(axis=2)
    ink = gray < INK
    h, w = gray.shape
    margin = round(w * 0.006)
    panels = find_panels(gray, ink, side)
    if len(panels) != 2:
        raise ValueError(f"expected 2 panels, found {len(panels)}")
    # Rules between units are long horizontal lines (often faint and tilted); text never is.
    lines = longest_runs(gray < 200) > w * 0.25
    lines = np.convolve(lines, np.ones(5), mode="same") > 0
    text_ink = ink & ~lines[:, None]

    units = []
    floor = 0
    for panel_top, panel_bottom in panels:
        if side == "A":
            # The run of gray columns through the page centre (scan shadows at the edge are separate).
            gray_columns = runs(np.median(gray[panel_top : panel_bottom + 1], axis=0) < PAPER, close=3)
            panel_columns = next(np.arange(a, b + 1) for a, b in gray_columns if a <= w // 2 <= b)
            # The ANSWERS label sits just above the gray panel.
            label = runs(text_ink[floor:panel_top].any(axis=1), close=2)
            if not label or panel_top - (floor + label[-1][1]) > h * 0.02:
                raise ValueError("ANSWERS label not found")
            panel_top = floor + label[-1][0]
        else:
            # From the left border to the right border (stray marks in the margin are ignored).
            coverage = ink[panel_top : panel_bottom + 1].mean(axis=0)
            left = int(np.argmax(coverage[: int(w * 0.3)]))
            right = int(w * 0.7) + int(np.argmax(coverage[int(w * 0.7) :]))
            panel_columns = np.array([left, right])

        # Sentence lines: the chain of text rows directly above the panel with small gaps.
        bands = [r for r in runs(text_ink[floor:panel_top].any(axis=1), close=3) if r[1] - r[0] >= 12]
        if not bands:
            raise ValueError("no sentence rows")
        chain = [bands[-1]]
        for band in reversed(bands[:-1]):
            if chain[0][0] - band[1] > h * 0.025:
                break
            chain.insert(0, band)
        s_top, s_bottom = floor + chain[0][0], floor + chain[-1][1]

        # Columns: [unit badge (Q)], checkbox, number, then the wide sentence text.
        block = text_ink[s_top : s_bottom + 1]
        columns = [c for c in runs(block.sum(axis=0) > 1, close=10) if c[1] - c[0] >= 3]
        text = next((c for c in columns if c[1] - c[0] > w * 0.15), None)
        if text is None:
            raise ValueError("sentence text column not found")
        text_left, text_right = text[0], columns[-1][1]
        # Rows of the text column only, so the unit badge does not stretch the rectangle.
        rows = [r for r in runs(block[:, text_left:].any(axis=1), close=3) if r[1] - r[0] >= 12]
        s_top, s_bottom = s_top + rows[0][0], s_top + rows[-1][1]

        def rect(x0, y0, x1, y1, extra_right=0):
            x0, y0 = max(0, x0 - margin), max(0, y0 - margin)
            x1, y1 = min(w, x1 + margin + extra_right + 1), min(h, y1 + margin + 1)
            return [round(x0 / w, 4), round(y0 / h, 4), round((x1 - x0) / w, 4), round((y1 - y0) / h, 4)]

        units.append(
            {
                # Faint glyph edges (e.g. a full-width "。") reach past the last inked column.
                "text": rect(text_left, s_top, text_right, s_bottom, extra_right=round(w * 0.012)),
                "panel": rect(int(panel_columns[0]), panel_top, int(panel_columns[-1]), panel_bottom),
                "lead": [round(c[0] / w, 3) for c in columns[: columns.index(text)]],
            }
        )
        floor = panel_bottom + 1
    return units


def main():
    pdf, first_page = sys.argv[1], int(sys.argv[2]) - 1
    option = lambda name: Path(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else None  # noqa: E731
    sheets, json_out = option("--sheets"), option("--json")
    doc = pymupdf.open(pdf)

    results, errors = {}, []
    for pair in range(UNIT_COUNT // 2):
        for side, offset in (("Q", 0), ("A", 1)):
            index = first_page + pair * 2 + offset
            image, rgb = page_rgb(doc, index)
            try:
                units = analyse(rgb, side)
            except ValueError as error:
                errors.append(f"page {index + 1} {side} (units {pair * 2 + 1}-{pair * 2 + 2}): {error}")
                continue
            for k, unit in enumerate(units):
                results[(pair * 2 + k + 1, side)] = unit
            if sheets:
                draw = ImageDraw.Draw(image)
                W, H = image.size
                for unit in units:
                    for key, colour in (("text", (0, 140, 255)), ("panel", (0, 190, 0))):
                        x, y, rw, rh = unit[key]
                        draw.rectangle([x * W, y * H, (x + rw) * W, (y + rh) * H], outline=colour, width=5)
                sheets.mkdir(parents=True, exist_ok=True)
                image.resize((W // 3, H // 3)).save(sheets / f"p{index + 1:03d}{side}.jpg", quality=70)

    print(f"detected {len(results)}/{UNIT_COUNT * 2} unit sides")
    print("\n".join(errors) or "no errors")
    for side in "QA":
        for key in ("text", "panel"):
            rects = {u: r[key] for (u, s), r in results.items() if s == side}
            median = np.median(np.array(list(rects.values())), axis=0)
            print(side, key, "median x/y/w/h", median.round(3))
            for unit, (x, _, rw, rh) in rects.items():
                odd = abs(x - median[0]) > 0.015 or rh < 0.05 or rh > 0.3
                if key == "panel":
                    odd = odd or abs(rw - median[2]) > 0.02
                if odd:
                    print(f"  outlier unit {unit}: {rects[unit]}")
    if json_out:
        json_out.write_text(json.dumps({f"{u}{s}": r for (u, s), r in sorted(results.items())}))


if __name__ == "__main__":
    main()
