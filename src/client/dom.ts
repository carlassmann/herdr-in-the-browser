type Child = Node | string | null | undefined | false;

type AttributeValue = string | number | boolean | EventListener | undefined;

interface Attributes {
  [name: string]: AttributeValue;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  applyAttributes(element, attributes);
  append(element, children);
  return element;
}

export function applyAttributes(element: Element, attributes: Attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === "function") {
      element.addEventListener(name.slice(2), value);
    } else if (value === undefined || value === false) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
}

export function replaceChildren(parent: Element, ...children: Child[]) {
  parent.replaceChildren();
  append(parent, children);
}

export function icon(paths: string[], viewBox = "0 0 16 16"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const definition of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", definition);
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("clip-rule", "evenodd");
    svg.appendChild(path);
  }
  return svg;
}
