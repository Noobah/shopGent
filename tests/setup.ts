import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom cleanup between tests.
afterEach(() => {
  cleanup();
});
