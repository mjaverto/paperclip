// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unpricedSuffix, unpricedTooltip, Costs } from "./Costs";

const budgetOverviewMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: vi.fn(),
  },
}));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("unpricedSuffix", () => {
  it("returns empty string for zero count", () => {
    expect(unpricedSuffix(0)).toBe("");
  });

  it("returns empty string for negative count", () => {
    expect(unpricedSuffix(-3)).toBe("");
  });

  it("renders singular form for exactly 1", () => {
    expect(unpricedSuffix(1)).toBe("(1 unpriced)");
  });

  it("renders plural form for >1", () => {
    expect(unpricedSuffix(7)).toBe("(7 unpriced)");
  });
});

describe("unpricedTooltip", () => {
  it("returns undefined for zero count so no title attribute is set", () => {
    expect(unpricedTooltip(0)).toBeUndefined();
  });

  it("uses singular wording for 1 run", () => {
    expect(unpricedTooltip(1)).toBe(
      "1 run missing cost data — total may be undercount.",
    );
  });

  it("uses plural wording for many runs", () => {
    expect(unpricedTooltip(12)).toBe(
      "12 runs missing cost data — total may be undercount.",
    );
  });
});

describe("Costs row rendering with unpriced counts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // Smoke check that the suffix renders inline next to a formatted cost when
  // unpricedRunCount > 0. The Costs page composes these primitives, so this
  // test covers the by-agent / by-project / by-agent-model surfaces.
  it("renders the compact suffix beside a cost value", () => {
    function ExampleRow({ cents, unpriced }: { cents: number; unpriced: number }) {
      return (
        <div title={unpricedTooltip(unpriced)} aria-label={unpricedTooltip(unpriced)}>
          <span className="font-medium tabular-nums">${(cents / 100).toFixed(2)}</span>
          {unpriced > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">
              {unpricedSuffix(unpriced)}
            </span>
          ) : null}
        </div>
      );
    }

    act(() => {
      root.render(<ExampleRow cents={12345} unpriced={3} />);
    });
    const wrapper = container.querySelector("div");
    expect(wrapper).not.toBeNull();
    expect(container.textContent).toContain("$123.45");
    expect(container.textContent).toContain("(3 unpriced)");
    expect(wrapper!.getAttribute("title")).toBe(
      "3 runs missing cost data — total may be undercount.",
    );
    expect(wrapper!.getAttribute("aria-label")).toBe(
      "3 runs missing cost data — total may be undercount.",
    );
  });

  it("omits the suffix and tooltip when unpriced count is zero", () => {
    function ExampleRow({ cents, unpriced }: { cents: number; unpriced: number }) {
      const tooltip = unpricedTooltip(unpriced);
      return (
        <div title={tooltip} aria-label={tooltip}>
          <span className="font-medium tabular-nums">${(cents / 100).toFixed(2)}</span>
          {unpriced > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">
              {unpricedSuffix(unpriced)}
            </span>
          ) : null}
        </div>
      );
    }

    act(() => {
      root.render(<ExampleRow cents={500} unpriced={0} />);
    });
    expect(container.textContent).not.toContain("unpriced");
    const wrapper = container.querySelector("div");
    expect(wrapper!.getAttribute("title")).toBeNull();
    expect(wrapper!.getAttribute("aria-label")).toBeNull();
  });
});

describe("Costs embedded Audit surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="budgets" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(budgetOverviewMock).toHaveBeenCalledWith("company-1");
        expect(container.textContent).toContain("Budget control plane");
      });
    });
    expect(container.textContent).not.toContain("Inference spend");
    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    for (const mock of Object.values(costsApiMocks)) expect(mock).not.toHaveBeenCalled();
  });
});
