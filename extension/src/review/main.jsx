import React from "react";
import { createRoot } from "react-dom/client";
import ReviewApp from "./ReviewApp.jsx";
import "../styles/index.css";
import "../styles/review.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ReviewApp />
  </React.StrictMode>
);
