import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "./api";
import type { Health } from "./types";
import { Dots } from "./ui";
import Home from "./views/Home";
import Deal from "./views/Deal";

// AG Grid is ~900 kB. The ledger is a secondary surface, so it is fetched on
// demand rather than paid for by everyone landing on the hero.
const Ledger = lazy(() => import("./views/Ledger"));

type Route = { dealId: string | null; view: "home" | "ledger" };

function parseRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const wantsLedger = params.get("view") === "ledger" || window.location.pathname === "/ledger";
  return {
    dealId: params.get("deal"),
    view: wantsLedger ? "ledger" : "home",
  };
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(next: Route) {
    setRoute(next);
    const qs = next.dealId ? `?deal=${next.dealId}` : next.view === "ledger" ? "?view=ledger" : "/";
    window.history.pushState({}, "", qs);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }

  const goHome = () => navigate({ dealId: null, view: "home" });
  const goLedger = () => navigate({ dealId: null, view: "ledger" });
  const goDeal = (id: string) => navigate({ dealId: id, view: "home" });

  return (
    <>
      <header className="topbar">
        <button className="logo" onClick={goHome} aria-label="Proven home">
          <span className="logo-mark" />
          <span className="logo-word serif">Proven</span>
        </button>

        <nav className="topnav">
          <button
            className={`nav-link ${route.view === "ledger" && !route.dealId ? "active" : ""}`}
            onClick={goLedger}
          >
            Ledger
          </button>
          <span className="nav-note">payment follows proof</span>
          <span className={`mode-pill ${health?.paypalConfigured ? "ok" : "warn"}`}>
            <i />
            {health?.paypalConfigured ? `PayPal ${health.paypalMode}` : "PayPal not configured"}
          </span>
        </nav>
      </header>

      {route.dealId ? (
        <Deal id={route.dealId} health={health} onBack={goHome} onNew={goHome} />
      ) : route.view === "ledger" ? (
        <Suspense
          fallback={
            <div className="loading-card">
              <Dots label="Loading the ledger" />
            </div>
          }
        >
          <Ledger onOpen={goDeal} onNew={goHome} />
        </Suspense>
      ) : (
        <Home onCreated={goDeal} />
      )}
    </>
  );
}
