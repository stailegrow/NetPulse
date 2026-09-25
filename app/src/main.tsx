import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Отключаем системное контекстное меню WebView (кроме полей ввода).
document.addEventListener("contextmenu", (e) => {
  const el = e.target as HTMLElement;
  if (!el.closest("input, textarea, .msg, .num")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
