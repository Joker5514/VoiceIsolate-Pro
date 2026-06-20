/* VoiceIsolate Pro — Minimal React DOM shim for _ds_bundle.js
 *
 * Provides the React API surface consumed by the design-system bundle:
 *   createElement, Fragment, useState (stateless), useEffect (run-once),
 *   useRef, createRef.
 *
 * Components render directly to real DOM nodes — no virtual DOM, no
 * reconciliation. Suitable for one-shot mounting of stateless DS components
 * like ProcessLoader; interactive hooks (useState re-renders) are no-ops.
 *
 * CSP note: this file is served from 'self' and uses no eval/inline code.
 */
(function () {
  'use strict';

  /* CSS properties whose numeric values do NOT get a 'px' unit appended. */
  const UNITLESS = new Set([
    'animationIterationCount', 'columnCount', 'flex', 'flexGrow',
    'flexNegative', 'flexOrder', 'flexPositive', 'flexShrink',
    'fontWeight', 'lineClamp', 'lineHeight', 'opacity', 'order',
    'orphans', 'tabSize', 'widows', 'zIndex', 'zoom',
  ]);

  /* Unique sentinel for Fragment — not a plain object so typeof checks work. */
  const Fragment = Object.freeze(Object.create(null));

  /* ---------- appendChild helper ------------------------------------------ */
  function appendChildren(parent, children) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c == null || c === false || c === true) continue;
      if (c instanceof Node) {
        parent.appendChild(c);
      } else if (Array.isArray(c)) {
        appendChildren(parent, c);
      } else {
        parent.appendChild(document.createTextNode(String(c)));
      }
    }
  }

  /* ---------- createElement ----------------------------------------------- */
  function createElement(type, props) {
    /* Collect variadic children into a flat array. */
    const children = [];
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (Array.isArray(c)) {
        for (let j = 0; j < c.length; j++) children.push(c[j]);
      } else {
        children.push(c);
      }
    }

    /* ── Component function ── */
    if (typeof type === 'function') {
      const p = props ? Object.assign({}, props) : {};
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return type(p);
    }

    /* ── Fragment ── */
    if (type === Fragment) {
      const frag = document.createDocumentFragment();
      appendChildren(frag, children);
      return frag;
    }

    /* ── DOM element ── */
    const el = document.createElement(type);

    if (props) {
      const keys = Object.keys(props);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const val = props[key];
        if (val == null || key === 'key' || key === 'children') continue;

        if (key === 'className') {
          el.className = String(val);
        } else if (key === 'htmlFor') {
          el.htmlFor = String(val);
        } else if (key === 'style' && typeof val === 'object') {
          const sk = Object.keys(val);
          for (let s = 0; s < sk.length; s++) {
            const prop = sk[s];
            const sv = val[prop];
            if (sv == null) continue;
            el.style[prop] = (typeof sv === 'number' && !UNITLESS.has(prop))
              ? sv + 'px' : String(sv);
          }
        } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n' &&
                   typeof val === 'function') {
          el.addEventListener(key[2].toLowerCase() + key.slice(3), val);
        } else {
          /* setAttribute handles aria-*, data-*, role, etc. */
          try { el.setAttribute(key, String(val)); } catch (_) { /* skip */ }
        }
      }
    }

    appendChildren(el, children);
    return el;
  }

  /* ---------- Hooks (stateless / run-once) -------------------------------- */
  function useState(init) {
    return [typeof init === 'function' ? init() : init, function () {}];
  }

  function useEffect(fn /*, deps */) {
    if (typeof fn === 'function') fn();
  }

  function useRef(init) {
    return { current: init === undefined ? null : init };
  }

  function createRef() {
    return { current: null };
  }

  /* ---------- Expose globals --------------------------------------------- */
  window.React = {
    createElement: createElement,
    Fragment: Fragment,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    createRef: createRef,
  };

  window.ReactDOM = {
    render: function (element, container) {
      container.innerHTML = '';
      if (element instanceof Node) container.appendChild(element);
    },
    createRoot: function (container) {
      return {
        render: function (element) {
          container.innerHTML = '';
          if (element instanceof Node) container.appendChild(element);
        },
      };
    },
  };
})();
