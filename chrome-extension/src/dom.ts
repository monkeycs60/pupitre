import type { DraftAnnotation } from "./types";

const STYLE_NAMES = [
  "display", "position", "width", "height", "marginTop", "marginRight",
  "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "color", "backgroundColor", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "textAlign", "border", "borderRadius", "gap",
  "alignItems", "justifyContent", "gridTemplateColumns", "flexDirection",
  "overflow", "zIndex", "opacity", "visibility",
] as const;

function escapeCss(value: string): string {
  return typeof globalThis.CSS?.escape === "function" ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/gu, "\\$&");
}

function selectorsFor(element: Element): string[] {
  const selectors: string[] = [];
  if (element.id) selectors.push(`#${escapeCss(element.id)}`);
  for (const attribute of ["data-testid", "data-test", "aria-label", "name"] as const) {
    const value = element.getAttribute(attribute);
    if (value) selectors.push(`[${attribute}="${escapeCss(value)}"]`);
  }
  const classes = [...element.classList].filter((value) => !/^(active|hover|focus|selected|open)$/iu.test(value)).slice(0, 3);
  selectors.push(`${element.tagName.toLowerCase()}${classes.map((value) => `.${escapeCss(value)}`).join("")}`);
  const chain: string[] = [];
  for (let node: Element | null = element; node && chain.length < 4; node = node.parentElement) {
    const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node!.tagName) : [];
    const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : "";
    chain.unshift(`${node.tagName.toLowerCase()}${nth}`);
  }
  selectors.push(chain.join(" > "));
  return [...new Set(selectors)].filter(Boolean).slice(0, 5);
}

function safeHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  const fields = [clone, ...clone.querySelectorAll("input, textarea, select")]
    .filter((node) => node.matches("input, textarea, select"));
  for (const field of fields) {
    field.removeAttribute("value");
    field.removeAttribute("checked");
    if (field instanceof HTMLInputElement) field.checked = false;
    if (field instanceof HTMLTextAreaElement) field.textContent = "";
    if (field instanceof HTMLSelectElement) {
      field.textContent = "";
      for (const option of field.querySelectorAll("option")) option.removeAttribute("selected");
    }
  }
  const editables = [clone, ...clone.querySelectorAll('[contenteditable="true"], [contenteditable=""]')]
    .filter((node) => node.matches('[contenteditable="true"], [contenteditable=""]'));
  for (const editable of editables) editable.textContent = "";
  clone.removeAttribute("value");
  return clone.outerHTML.slice(0, 12 * 1024);
}

export function inspectElement(element: Element, click: { x: number; y: number }): Omit<DraftAnnotation, "instruction"> {
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const styles = Object.fromEntries(STYLE_NAMES.map((name) => [name, computed[name]]).filter(([, value]) => value));
  return {
    point: {
      x: click.x, y: click.y, elementX: click.x - rect.left, elementY: click.y - rect.top,
      documentX: click.x + scrollX, documentY: click.y + scrollY,
    },
    captureRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, devicePixelRatio },
    selectors: selectorsFor(element),
    html: safeHtml(element),
    styles,
  };
}
