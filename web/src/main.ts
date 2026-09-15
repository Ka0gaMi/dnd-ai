import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

// Apply the remembered theme before the first paint; "system" leaves the attribute off.
const savedTheme = localStorage.getItem('dnd-ai.theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

export default mount(App, { target: document.getElementById('app')! });
