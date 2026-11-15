import type { Metadata } from "next";
import { AccountsView } from "@/components/AccountsView";

export const metadata: Metadata = { title: "账号管理 · Viggle Studio" };

export default function Page() {
  return <AccountsView />;
}
