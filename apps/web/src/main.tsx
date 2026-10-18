import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });

createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
