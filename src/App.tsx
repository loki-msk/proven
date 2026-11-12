import { useEffect, useState } from "react";
import { api } from "./api";
import type { Health } from "./types";
import Home from "./views/Home";
import Deal from "./views/Deal";

function fromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("deal");
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dealId, setDealId] = useState<string | null>(fromUrl());

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    const onPop = () => setDealId(fromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function go(id: string | null) {
    setDealId(id);
    window.history.pushState({}, "", id ? `/?deal=${id}` : "/");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }

  return (
    <>
      <header className="topbar">
        <button className="logo" onClick={() => go(null)} aria-label="Proven home">
          <span className="logo-mark" />
          <span className="logo-word serif">Proven</span>
        </button>

        <nav className="topnav">
          <span className="nav-note">payment follows proof</span>
          <span className={`mode-pill ${health?.paypalConfigured ? "ok" : "warn"}`}>
            <i />
            {health?.paypalConfigured ? `PayPal ${health.paypalMode}` : "PayPal not configured"}
          </span>
        </nav>
      </header>

      {dealId ? (
        <Deal id={dealId} health={health} onBack={() => go(null)} onNew={() => go(null)} />
      ) : (
        <Home onCreated={go} />
      )}
    </>
  );
}
