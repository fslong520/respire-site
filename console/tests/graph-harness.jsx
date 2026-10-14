import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import GraphView from '../src/GraphView.jsx';
import { setLocale } from '../src/i18n.js';
import '../src/console.css';
function Harness() {
  const [items, setItems] = useState([]);
  const [, render] = useState(0);
  window.setGraph = setItems;
  window.graphLocale = locale => { setLocale(locale); render(n => n + 1); };
  window.opened ??= [];
  return <GraphView items={items} onOpen={id => window.opened.push(id)} />;
}
createRoot(document.getElementById('root')).render(<StrictMode><Harness /></StrictMode>);
