import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Admin from "./pages/Admin";
import Account from "./pages/Account";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/account" element={<Account />} />
      <Route path="/" element={<Navigate to="/account" replace />} />
    </Routes>
  );
}
