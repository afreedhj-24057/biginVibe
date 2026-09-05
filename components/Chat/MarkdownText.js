"use client";
import { Fragment } from "react";

function renderInline(text) {
  const nodes = [];
  const rx = /(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let m;

  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`t-${key++}`}>{text.slice(last, m.index)}</Fragment>);

    if (m[1]) {
      const label = m[1].match(/^\[([^\]]+)\]/)?.[1] || m[1];
      nodes.push(
        <a key={`a-${key++}`} href={m[2]} target="_blank" rel="noreferrer">
          {label}
        </a>
      );
    } else if (m[3]) {
      nodes.push(<code key={`c-${key++}`}>{m[3].slice(1, -1)}</code>);
    } else if (m[4]) {
      nodes.push(<strong key={`b-${key++}`}>{m[4].slice(2, -2)}</strong>);
    } else if (m[5]) {
      nodes.push(<em key={`i-${key++}`}>{m[5].slice(1, -1)}</em>);
    }

    last = rx.lastIndex;
  }

  if (last < text.length) nodes.push(<Fragment key={`t-${key++}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

function renderTextBlock(text, baseKey) {
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <Fragment key={`${baseKey}-line-${i}`}>
      {renderInline(line)}
      {i < lines.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

export default function MarkdownText({ text }) {
  if (!text) return null;

  const out = [];
  const rx = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  let key = 0;

  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <p className="md-p" key={`p-${key++}`}>
          {renderTextBlock(text.slice(last, m.index), `p-${key}`)}
        </p>
      );
    }

    out.push(
      <pre className="md-pre" key={`pre-${key++}`}>
        <code>{m[2] || ""}</code>
      </pre>
    );
    last = rx.lastIndex;
  }

  if (last < text.length) {
    out.push(
      <p className="md-p" key={`p-${key++}`}>
        {renderTextBlock(text.slice(last), `p-${key}`)}
      </p>
    );
  }

  return <div className="markdown-text">{out}</div>;
}
