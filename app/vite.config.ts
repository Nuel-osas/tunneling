import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fundPlugin } from "./server/fund";

export default defineConfig({
  plugins: [react(), fundPlugin()],
  server: { port: 5175 },
});
