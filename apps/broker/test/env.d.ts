import type { BrokerEnv } from "../src/contracts";

declare global {
  namespace Cloudflare {
    interface Env extends BrokerEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index");
      durableNamespaces: "OAuthTransactionObject" | "AuthSessionObject";
    }
  }
}

export {};
