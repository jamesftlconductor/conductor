import { useState, useEffect } from "react";
import "./App.css";

const STATUS_CONFIG = {
  "In Transit":   { color: "var(--c-blue)",   bg: "var(--c-blue-bg)"   },
  "Delivered":    { color: "var(--c-green)",  bg: "var(--c-green-bg)"  },
  "Out for Delivery": { color: "var(--c-amber)", bg: "var(--c-amber-bg)" },
  "Delayed":      { color: "var(--c-red)",    bg: "var(--c-red-bg)"    },
  "Unknown":      { color: "var(--c-muted)",  bg: "var(--c-muted-bg)"  },
};

function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG["Unknown"];
  return <span className="status-badge" style={{ color: config.color, background: config.bg }}>{status}</span>;
}

function StatCard({ label, value, accent }) {
  return (
    <div className="stat-card">
      <span className="stat-value" style={accent ? { color: accent } : {}}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export default function App() {
  const [shipments, setShipments] = useState([]);
  const [filter, setFilter] = useState("All");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchShipments();
    const interval = setInterval(fetchShipments, 30000);
    return () => clearInterval(interval);
  }, []);

  async function fetchShipments() {
    try {
      const res = await fetch("https://conductor-ivory.vercel.app/api/signals");
      const data = await res.json();
      // /api/signals returns { household, signals } — unwrap to keep the
      // table-rendering shape the rest of this component expects.
      setShipments(Array.isArray(data?.signals) ? data.signals : []);
    } catch (err) {
      console.error("Failed to fetch signals:", err);
    } finally {
      setLoading(false);
    }
  }

  async function deleteShipment(id) {
    try {
      await fetch("https://conductor-ivory.vercel.app/api/signals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setShipments((prev) => prev.filter((s) => String(s.id) !== String(id)));
    } catch (err) {
      console.error("Failed to delete signal:", err);
    }
  }

  const statuses = ["All", ...Object.keys(STATUS_CONFIG)];
  const filtered = filter === "All" ? shipments : shipments.filter((s) => s.status === filter);
  const counts = {
    total: shipments.length,
    inTransit: shipments.filter((s) => s.status === "In Transit").length,
    delivered: shipments.filter((s) => s.status === "Delivered").length,
    delayed: shipments.filter((s) => s.status === "Delayed").length,
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <span className="logo-mark">C</span>
            <span className="logo-text">Conductor</span>
          </div>
          <span className="header-tagline">Delivery Intelligence</span>
        </div>
        <div className="header-right">
          <button className="btn-import" onClick={fetchShipments}>
            <span className="btn-icon">↻</span>
            Refresh
          </button>
        </div>
      </header>

      <main className="main">
        <div className="stats-row">
          <StatCard label="Total Shipments" value={counts.total} />
          <StatCard label="In Transit" value={counts.inTransit} accent="var(--c-blue)" />
          <StatCard label="Delivered" value={counts.delivered} accent="var(--c-green)" />
          <StatCard label="Delayed" value={counts.delayed} accent="var(--c-red)" />
        </div>

        <div className="filter-row">
          {statuses.map((s) => (
            <button key={s} className={`filter-tab ${filter === s ? "active" : ""}`} onClick={() => setFilter(s)}>{s}</button>
          ))}
        </div>

        {loading ? (
          <div className="empty-state">
            <p className="empty-title">Loading shipments...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <p className="empty-title">No shipments yet</p>
            <p className="empty-sub">Conductor is watching your Gmail for shipping emails. They'll appear here automatically.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="shipments-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Carrier</th>
                  <th>Tracking #</th>
                  <th>Sender</th>
                  <th>Status</th>
                  <th>ETA</th>
                  <th>Last Update</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => (
                  <tr key={s.id || i} className="shipment-row">
                    <td className="td-description">{s.description}</td>
                    <td className="td-carrier">{s.carrier}</td>
                    <td className="td-tracking">{s.trackingNumber}</td>
                    <td>{s.sender}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="td-eta">{s.eta}</td>
                    <td className="td-update">{s.lastUpdate}</td>
                    <td>
                      <button
                        className="btn-delete"
                        onClick={() => deleteShipment(s.id)}
                        title="Delete"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}