import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { LogoMark } from "./components/Logo";
import { AuthGate, useAuth, type AuthAccess } from "./components/AuthGate";
import { StoreProvider, useStores } from "./components/StoreContext";
import { Dashboard } from "./pages/Dashboard";
import { Operations } from "./pages/Operations";
import { Fleet } from "./pages/Fleet";
import { BookingsList } from "./pages/BookingsList";
import { BookingNew } from "./pages/BookingNew";
import { BookingDetail } from "./pages/BookingDetail";
import { ProductsList } from "./pages/ProductsList";
import { ProductDetail } from "./pages/ProductDetail";
import { Courses } from "./pages/Courses";
import { SettingsPage } from "./pages/Settings";
import { ContractTemplate } from "./pages/ContractTemplate";
import { Reminders } from "./pages/Reminders";
import { TenantsPage } from "./pages/Tenants";
import { Reports } from "./pages/Reports";
import { WaitlistPage } from "./pages/Waitlist";
import { AvailabilityRulesPage } from "./pages/AvailabilityRules";
import { Team } from "./pages/Team";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Settings } from "./api";
import { setDisplayCurrency } from "./format";
import { I18nProvider, useI18n, type UiLanguage } from "./components/I18n";

type PermissionNeed = keyof AuthAccess["permissions"] | "manage";

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  need?: PermissionNeed;
}

interface NavGroup {
  label: string;
  children: NavItem[];
}

const NAV_ITEMS: (NavItem | NavGroup)[] = [
  { to: "/", label: "Dashboard", end: true },
  {
    label: "Bookings",
    children: [
      { to: "/bookings", label: "All bookings", end: true, need: "bookings" },
      { to: "/courses", label: "Sessions & Resources", end: false, need: "sessions" },
    ],
  },
  {
    label: "Settings",
    children: [
      { to: "/products/rentals", label: "Rentals", end: false, need: "products" },
      { to: "/products/courses", label: "Courses", end: false, need: "products" },
      { to: "/products/services", label: "Services", end: false, need: "products" },
      { to: "/fleet", label: "Rental fleet", end: false, need: "products" },
      { to: "/availability-rules", label: "Hours & blackouts", end: false, need: "availability" },
      { to: "/team", label: "Team", end: true, need: "manage" },
      { to: "/contract-template", label: "Contract template", end: false, need: "manage" },
      { to: "/reminders", label: "Reminders", end: false, need: "manage" },
      { to: "/settings", label: "General", end: false, need: "manage" },
    ],
  },
  { to: "/reports", label: "Reports", end: false, need: "reports" },
  { to: "/tenants", label: "Tenants", end: false },
];

interface RequirePermProps {
  need: PermissionNeed;
  children: ReactNode;
}

function RequirePerm({ need, children }: RequirePermProps) {
  const { access } = useAuth();
  const allowed = need === "manage"
    ? access?.canManageUsers === true
    : access?.permissions[need] === true;
  if (allowed) return <>{children}</>;
  return (
    <div className="page">
      <h1>No access</h1>
      <p>Your account doesn't have access to this section.</p>
    </div>
  );
}

function StoreSelector() {
  const { stores, storeId, setStoreId, loading } = useStores();
  const { t } = useI18n();
  return (
    <label className="store-selector">
      <span className="store-selector-label">{t("Store")}</span>
      <select
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
        disabled={loading}
      >
        <option value="">{t("All stores")}</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {s.city}
          </option>
        ))}
      </select>
    </label>
  );
}

function NavGroupRow({ group, children }: { group: NavGroup; children: NavItem[] }) {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(
    () => children.some((item) => pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`))),
  );
  useEffect(() => {
    if (children.some((item) => pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`)))) {
      setExpanded(true);
    }
    // The visible child routes are fixed for a signed-in access profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div className="nav-group">
      <button
        type="button"
        className={`nav-group-toggle ${expanded ? "expanded" : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{t(group.label)}</span>
        <span className="nav-group-chevron" aria-hidden="true">▸</span>
      </button>
      <div className={`nav-group-children ${expanded ? "" : "collapsed"}`}>
        {children.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            {t(item.label)}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

function Shell() {
  const { language, setLanguage, t } = useI18n();
  const { access } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const canSee = (item: NavItem) => {
    if (!item.need) return true;
    if (item.need === "manage") return access?.canManageUsers === true;
    return access?.permissions[item.need] === true;
  };
  // Platform super-admin context: shows the tenant banner when operating a
  // tenant other than the default.
  const [admin, setAdmin] = useState<{ email: string; tenant: string | null } | null>(null);
  useEffect(() => {
    api<{ settings: Partial<Settings> }>("/api/settings")
      .then(({ settings }) => setDisplayCurrency(settings.currency || "CAD"))
      .catch(() => {});
  }, []);
  useEffect(() => {
    api<{ email: string; tenant: string | null }>("/api/admin/me").then(setAdmin).catch(() => setAdmin(null));
  }, []);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;

    document.body.classList.add("menu-open");
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.classList.remove("menu-open");
    };
  }, [menuOpen]);
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
        <button
          type="button"
          className="burger"
          aria-label={t("Menu")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <nav className="nav">
          {NAV_ITEMS.map((entry) => {
            if ("children" in entry) {
              const visibleChildren = entry.children.filter(canSee);
              return visibleChildren.length > 0
                ? <NavGroupRow key={entry.label} group={entry} children={visibleChildren} />
                : null;
            }
            if (entry.to === "/tenants" && !admin) return null;
            if (!canSee(entry)) return null;
            return (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={entry.end}
                className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
              >
                {t(entry.label)}
              </NavLink>
            );
          })}
        </nav>
        {menuOpen && (
          <div className="mobile-drawer-backdrop" onClick={() => setMenuOpen(false)} />
        )}
        {menuOpen && (
          <div className="mobile-drawer">
            {NAV_ITEMS.map((entry) => {
              if ("children" in entry && entry.label === "Settings") return null;
              if ("children" in entry) {
                const visibleChildren = entry.children.filter(canSee);
                if (visibleChildren.length === 0) return null;
                return visibleChildren.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    {t(item.label)}
                  </NavLink>
                ));
              }
              if (entry.to === "/tenants" && !admin) return null;
              if (!canSee(entry)) return null;
              return (
                <NavLink
                  key={entry.to}
                  to={entry.to}
                  end={entry.end}
                  className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                  onClick={() => setMenuOpen(false)}
                >
                  {t(entry.label)}
                </NavLink>
              );
            })}
          </div>
        )}
        <div className="sidebar-foot">{t("Staff back office")}</div>
      </aside>
      <div className="main">
        {admin?.tenant && (
          <div className="tenant-banner">
            Operating tenant: <strong>{admin.tenant}</strong> as {admin.email}
            <button type="button" onClick={() => void exitTenant()}>Exit</button>
          </div>
        )}
        <header className="topbar">
          <label className="store-selector">
            <span className="store-selector-label">{t("Admin language")}</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value as UiLanguage)}>
              <option value="en">English</option><option value="fr">Français</option><option value="es">Español</option>
            </select>
          </label>
          <StoreSelector />
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/bookings" element={<RequirePerm need="bookings"><BookingsList /></RequirePerm>} />
            <Route path="/bookings/new" element={<RequirePerm need="bookings"><BookingNew /></RequirePerm>} />
            <Route path="/bookings/:id" element={<RequirePerm need="bookings"><BookingDetail /></RequirePerm>} />
            <Route path="/products/rentals" element={<RequirePerm need="products"><ProductsList typeFilter="RENTAL" /></RequirePerm>} />
            <Route path="/products/courses" element={<RequirePerm need="products"><ProductsList typeFilter="COURSE" /></RequirePerm>} />
            <Route path="/products/services" element={<RequirePerm need="products"><ProductsList typeFilter="SERVICE" /></RequirePerm>} />
            <Route path="/products" element={<Navigate to="/products/rentals" replace />} />
            <Route path="/fleet" element={<RequirePerm need="products"><Fleet /></RequirePerm>} />
            <Route path="/products/:id" element={<RequirePerm need="products"><ProductDetail /></RequirePerm>} />
            <Route path="/courses" element={<RequirePerm need="sessions"><Courses /></RequirePerm>} />
            <Route path="/settings" element={<RequirePerm need="manage"><SettingsPage /></RequirePerm>} />
            <Route path="/contract-template" element={<RequirePerm need="manage"><ContractTemplate /></RequirePerm>} />
            <Route path="/reminders" element={<RequirePerm need="manage"><Reminders /></RequirePerm>} />
            <Route path="/reports" element={<RequirePerm need="reports"><Reports /></RequirePerm>} />
            <Route path="/waitlist" element={<RequirePerm need="bookings"><WaitlistPage /></RequirePerm>} />
            <Route path="/availability-rules" element={<RequirePerm need="availability"><AvailabilityRulesPage /></RequirePerm>} />
            <Route path="/team" element={<RequirePerm need="manage"><Team /></RequirePerm>} />
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
        <I18nProvider><AuthGate><StoreProvider><Shell /></StoreProvider></AuthGate></I18nProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
