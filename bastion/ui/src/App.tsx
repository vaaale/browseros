import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import Admin from "./pages/Admin";
import Account from "./pages/Account";

function BootstrapGuard({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Skip the check if we're already on /setup or /login to avoid redirect loops.
    if (location.pathname === "/setup" || location.pathname === "/login") {
      setChecked(true);
      return;
    }
    fetch("/setup/state")
      .then((r) => r.json() as Promise<{ needsBootstrap: boolean; authProvider: string }>)
      .then((d) => {
        if (d.needsBootstrap) navigate("/setup", { replace: true });
        else setChecked(true);
      })
      .catch(() => setChecked(true));
  }, [location.pathname, navigate]);

  if (!checked && location.pathname !== "/setup" && location.pathname !== "/login") return null;
  return <>{children}</>;
}

export default function App() {
  return (
    <BootstrapGuard>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/account" element={<Account />} />
        <Route path="/" element={<Navigate to="/account" replace />} />
      </Routes>
    </BootstrapGuard>
  );
}
