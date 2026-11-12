import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { api, ApiError } from "../api";
import type { AgreementSummary } from "../types";
import { Button, Card, Notice, StatusPill, clock, day, money, pct, short } from "../ui";

/**
 * The settlement ledger.
 *
 * Dense by nature: one row per agreement, money in, money out, confidence, and
 * the state machine's current position. This is the view a merchant or a
 * controller would actually live in — which is why it is a real data grid and
 * not a list of cards.
 */
export default function Ledger({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [rows, setRows] = useState<AgreementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const { agreements } = await api.listAgreements();
      setRows(agreements);
    } catch (err) {
      setError((err as ApiError).message);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const list = rows ?? [];
    const settled = list.filter((r) => r.settledAt);
    return {
      count: list.length,
      settled: settled.length,
      volume: settled.reduce((s, r) => s + r.totalCents, 0),
      released: list.reduce((s, r) => s + r.releasedCents, 0),
      returned: list.reduce((s, r) => s + r.returnedCents, 0),
      held: list
        .filter((r) => ["AGREED", "FUNDED", "EVIDENCE", "ADJUDICATED"].includes(r.status))
        .reduce((s, r) => s + r.totalCents, 0),
    };
  }, [rows]);

  const columnDefs = useMemo<ColDef<AgreementSummary>[]>(
    () => [
      {
        headerName: "Agreement",
        field: "title",
        flex: 2.4,
        minWidth: 240,
        cellRenderer: (p: ICellRendererParams<AgreementSummary>) =>
          p.data ? (
            <div className="led-title">
              <span className="led-name">{p.data.title}</span>
              <span className="led-id mono">{short(p.data.id, 14)}</span>
            </div>
          ) : null,
      },
      {
        headerName: "Status",
        field: "status",
        width: 148,
        cellRenderer: (p: ICellRendererParams<AgreementSummary>) =>
          p.data ? <StatusPill status={p.data.status} /> : null,
      },
      {
        headerName: "Split",
        width: 132,
        sortable: false,
        filter: false,
        cellRenderer: (p: ICellRendererParams<AgreementSummary>) => <SplitBar row={p.data} />,
      },
      {
        headerName: "Contract",
        field: "totalCents",
        width: 124,
        type: "rightAligned",
        valueFormatter: (p: ValueFormatterParams<AgreementSummary>) => money(p.value ?? 0),
      },
      {
        headerName: "Released",
        field: "releasedCents",
        width: 124,
        type: "rightAligned",
        cellClass: "cell-mint",
        valueFormatter: (p: ValueFormatterParams<AgreementSummary>) =>
          p.value ? money(p.value) : "—",
      },
      {
        headerName: "Returned",
        field: "returnedCents",
        width: 124,
        type: "rightAligned",
        cellClass: "cell-dim",
        valueFormatter: (p: ValueFormatterParams<AgreementSummary>) =>
          p.value ? money(p.value) : "—",
      },
      {
        headerName: "Clauses",
        field: "clauseCount",
        width: 100,
        type: "rightAligned",
        cellClass: "cell-dim",
      },
      {
        headerName: "Confidence",
        field: "confidence",
        width: 118,
        type: "rightAligned",
        cellClass: "cell-dim",
        valueFormatter: (p: ValueFormatterParams<AgreementSummary>) =>
          p.value == null ? "—" : pct(p.value),
      },
      {
        headerName: "Parties",
        width: 190,
        sortable: false,
        filter: false,
        cellRenderer: (p: ICellRendererParams<AgreementSummary>) =>
          p.data ? (
            <span className="led-parties">
              {p.data.buyerName} <span className="faint">→</span> {p.data.sellerName}
            </span>
          ) : null,
      },
      {
        headerName: "Opened",
        field: "createdAt",
        width: 116,
        cellClass: "cell-dim mono",
        valueFormatter: (p: ValueFormatterParams<AgreementSummary>) =>
          p.value ? `${day(p.value)} ${clock(p.value)}` : "—",
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<AgreementSummary>>(
    () => ({
      resizable: true,
      sortable: true,
      filter: true,
      suppressHeaderMenuButton: false,
    }),
    [],
  );

  return (
    <main className="ledger-page">
      <div className="ledger-head">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-dot" />
            Settlement ledger
          </div>
          <h1 className="serif">
            Every deal, and exactly <em>how it settled.</em>
          </h1>
          <p className="lede small-lede">
            One row per agreement. Contract value, what PayPal captured, what it voided, and how
            confident the adjudication was. Click any row to open the deal room.
          </p>
        </div>
        <div className="ledger-head-actions">
          <Button variant="ghost" onClick={load}>
            Refresh
          </Button>
          <Button variant="primary" onClick={onNew}>
            New agreement →
          </Button>
        </div>
      </div>

      <div className="ledger-stats">
        <Card className="stat">
          <span className="muted small">Agreements</span>
          <strong className="mono">{stats.count}</strong>
          <span className="micro">{stats.settled} settled</span>
        </Card>
        <Card className="stat">
          <span className="muted small">Settled volume</span>
          <strong className="mono">{money(stats.volume)}</strong>
          <span className="micro">through PayPal capture</span>
        </Card>
        <Card className="stat">
          <span className="muted small">Released</span>
          <strong className="mono mint">{money(stats.released)}</strong>
          <span className="micro">earned against proof</span>
        </Card>
        <Card className="stat">
          <span className="muted small">Returned</span>
          <strong className="mono amber">{money(stats.returned)}</strong>
          <span className="micro">voided, never charged</span>
        </Card>
        <Card className="stat">
          <span className="muted small">Currently held</span>
          <strong className="mono">{money(stats.held)}</strong>
          <span className="micro">authorized, not captured</span>
        </Card>
      </div>

      {error && (
        <Notice tone="red" title="Could not load the ledger">
          {error}
        </Notice>
      )}

      <Card className="ledger-card">
        <div className="ledger-toolbar">
          <span className="muted small">
            {rows === null ? "Loading…" : `${rows.length} agreement${rows.length === 1 ? "" : "s"}`}
          </span>
          <input
            className="input ledger-search"
            placeholder="Filter by agreement, party, status…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter agreements"
          />
        </div>

        <div className="ag-theme-quartz-dark ledger-grid">
          <AgGridReact<AgreementSummary>
            rowData={rows ?? []}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            quickFilterText={query}
            domLayout="autoHeight"
            rowHeight={52}
            headerHeight={40}
            animateRows
            rowStyle={{ cursor: "pointer" }}
            onRowClicked={(e) => {
              if (e.data) onOpen(e.data.id);
            }}
            overlayNoRowsTemplate={
              rows === null
                ? `<span class="ledger-empty">Loading the ledger…</span>`
                : `<span class="ledger-empty">No agreements yet. <b>Start one</b> and it appears here the moment it is drafted.</span>`
            }
          />
        </div>
      </Card>

      <p className="micro ledger-foot">
        Amounts are computed server-side from clause weights and per-clause fractions. The model never
        emits a dollar figure. Grid: AG Grid Community.
      </p>
    </main>
  );
}

function SplitBar({ row }: { row?: AgreementSummary }) {
  if (!row) return null;
  const total = row.totalCents || 1;
  const hasMoney = row.releasedCents > 0 || row.returnedCents > 0;

  if (!hasMoney) {
    return <span className="mini-bar mini-idle" title="Nothing settled yet" />;
  }

  const rel = Math.min(100, Math.max(0, (row.releasedCents / total) * 100));
  return (
    <span
      className="mini-bar"
      title={`${money(row.releasedCents)} released · ${money(row.returnedCents)} returned`}
    >
      <i className="mini-rel" style={{ width: `${rel}%` }} />
      <i className="mini-ret" style={{ width: `${100 - rel}%` }} />
    </span>
  );
}
