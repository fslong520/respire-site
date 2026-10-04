import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource-variable/noto-serif-sc';
import '@fontsource-variable/work-sans';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
