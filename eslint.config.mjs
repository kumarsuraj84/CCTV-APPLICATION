import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The job engine's test helpers and fake adapter prove orchestration only; application code must never use them.
    files: ["app/**", "components/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@/lib/jobs/testing", "@/lib/jobs/fake-adapter", "**/lib/jobs/testing", "**/lib/jobs/fake-adapter"],
          message: "lib/jobs/testing and lib/jobs/fake-adapter are test-only (fake adapters prove orchestration, not device behaviour).",
        }],
      }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "reference/**", "docs/**", ".superpowers/**", "supabase/**", "types/database.ts",
    // Final fix Y (review B minor 5): third-party files kept byte for byte (pinned by tests/unit/player-script.test.ts).
    "public/vendor/**"]),
]);

export default eslintConfig;
