// @ts-check
import { parse } from 'parse5';

/** @typedef {import('parse5').DefaultTreeAdapterMap['node']} HtmlNode */
/** @typedef {import('parse5').DefaultTreeAdapterMap['element']} HtmlElement */

/** @param {HtmlElement} element @param {string} name */
export function htmlAttribute(element, name) {
  return element.attrs.find((attribute) => attribute.name === name && !attribute.namespace)?.value;
}

/** Parse once with browser HTML rules; template descendants remain inert. @param {string} html */
export function parseArtifactHtml(html) {
  const document = parse(html, { scriptingEnabled: true, sourceCodeLocationInfo: true });
  /** @type {HtmlElement[]} */
  const allElements = [];
  /** @type {HtmlElement[]} */
  const activeElements = [];
  /** @param {HtmlNode} node @param {boolean} inert */
  function visit(node, inert) {
    if ('tagName' in node) {
      allElements.push(node);
      if (!inert) activeElements.push(node);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, inert);
    if ('content' in node) visit(node.content, true);
  }
  visit(document, false);
  return { allElements, activeElements };
}

/** @param {HtmlElement[]} elements @param {string} expectedCsp */
export function hasActiveCsp(elements, expectedCsp) {
  const policies = elements.filter(
    (element) =>
      element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      element.tagName === 'meta' &&
      htmlAttribute(element, 'http-equiv')?.toLowerCase() === 'content-security-policy' &&
      element.parentNode &&
      'tagName' in element.parentNode &&
      element.parentNode.tagName === 'head',
  );
  const first = policies[0];
  const offset = first?.sourceCodeLocation?.startOffset;
  if (offset === undefined || policies.some((policy) => htmlAttribute(policy, 'content') !== expectedCsp)) return false;
  return !elements.some(
    (element) =>
      ['base', 'link', 'script', 'style'].includes(element.tagName) &&
      (element.sourceCodeLocation?.startOffset ?? -1) < offset,
  );
}

/** @param {HtmlElement} element */
export function scriptText(element) {
  return element.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
}
