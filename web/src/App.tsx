import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { LogoMark } from "./components/Logo";
import { AuthGate } from "./components/AuthGate";
import { StoreProvider, useStores } from "./components/StoreContext";
import { Dashboard } from "./pages/Dashboard";
import { BookingsList } from "./pages/BookingsList";
import { BookingNew } from "./pages/BookingNew";
import { BookingDetail } from "./pages/BookingDetail";
import { ProductsList } from "./pages/ProductsList";
import { ProductDetail } from "./pages/ProductDetail";
import { Courses } from "./pages/Courses";
import { SettingsPage } from "./pages/Settings";
import { TenantsPage } from "./pages/Tenants";
import { useEffect, useState } from "react";
import { api } from "./api";

const NAV_ITEMS: { to: string; label: string; end: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/bookings", label: "Bookings", end: true },
  { to: "/bookings/new", label: "New booking", end: true },
  { to: "/products", label: "Products", end: false },
  { to: "/courses", label: "Sessions & Resources", end: false },
  { to: "/settings", label: "Settings", end: false },
  { to: "/tenants", label: "Tenants", end: false },
];

function StoreSelector() {
  const { stores, storeId, setStoreId, loading } = useStores();
  return (
    <label className="store-selector">
      <span className="store-selector-label">Store</span>
      <select
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
        disabled={loading}
      >
        <option value="">All stores</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {s.city}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell() {
  // Platform super-admin context: shows the tenant banner when operating a
  // tenant other than the default.
  const [admin, setAdmin] = useState<{ email: string; tenant: string | null } | null>(null);
  useEffect(() => {
    api<{ email: string; tenant: string | null }>("/api/admin/me").then(setAdmin).catch(() => setAdmin(null));
  }, []);
  const exitTenant = async () => {
    await api("/api/admin/use-tenant", { body: { slug: null } }).catch(() => {});
    window.location.href = "/tenants";
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <LogoMark size={34} />
          <span className="logo-text">
            Reservly
            <small>Booking Desk</small>
          </span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">Staff back office</div>
      </aside>
      <div className="main">
        {admin?.tenant && (
          <div className="tenant-banner">
            Operating tenant: <strong>{admin.tenant}</strong> as {admin.email}
            <button type="button" onClick={() => void exitTenant()}>Exit</button>
          </div>
        )}
        <header className="topbar">
          <StoreSelector />
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bookings" element={<BookingsList />} />
            <Route path="/bookings/new" element={<BookingNew />} />
            <Route path="/bookings/:id" element={<BookingDetail />} />
            <Route path="/products" element={<ProductsList />} />
            <Route path="/products/:id" element={<ProductDetail />} />
            <Route path="/courses" element={<Courses />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/tenants" element={<TenantsPage />} />
            <Route path="*" element={<div className="page"><h1>Not found</h1></div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthGate>
          <StoreProvider>
            <Shell />
          </StoreProvider>
        </AuthGate>
      </ToastProvider>
    </BrowserRouter>
  );
}
