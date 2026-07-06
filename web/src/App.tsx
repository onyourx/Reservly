import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { StoreProvider, useStores } from "./components/StoreContext";
import { Dashboard } from "./pages/Dashboard";
import { BookingsList } from "./pages/BookingsList";
import { BookingNew } from "./pages/BookingNew";
import { BookingDetail } from "./pages/BookingDetail";
import { ProductsList } from "./pages/ProductsList";
import { ProductDetail } from "./pages/ProductDetail";
import { Courses } from "./pages/Courses";
import { SettingsPage } from "./pages/Settings";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/bookings", label: "Bookings", end: true },
  { to: "/bookings/new", label: "New booking", end: true },
  { to: "/products", label: "Products", end: false },
  { to: "/courses", label: "Sessions & Resources", end: false },
  { to: "/settings", label: "Settings", end: false },
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
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">BD</span>
          <span className="logo-text">
            Booking Desk
            <small>Gosselin</small>
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
        <StoreProvider>
          <Shell />
        </StoreProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
