// The environment selected for a product, shared by all of its sections: one choice per product,
// remembered per browser (localStorage) and reflected in the URL (`#/p/<id>/<section>?env=<env>`).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isEnvironment, type Environment } from '@z-cloudbase/contracts';

const KEY = 'zcb.console.env.';
const DEFAULT_ENV: Environment = 'prod';

function stored(productId: string): Environment | null {
  try {
    const v = localStorage.getItem(KEY + productId);
    return isEnvironment(v) ? v : null;
  } catch {
    return null;
  }
}
function store(productId: string, env: Environment) {
  try {
    localStorage.setItem(KEY + productId, env);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

/** `wanted` if the product has it, else prod, else its first environment. */
export const pickEnv = (envs: readonly Environment[], wanted: Environment | null): Environment =>
  wanted && envs.includes(wanted) ? wanted : envs.includes(DEFAULT_ENV) ? DEFAULT_ENV : (envs[0] ?? DEFAULT_ENV);

interface ProductEnv {
  env: Environment;
  setEnv: (e: Environment) => void;
  /** The product's environments, for `EnvSelect`. */
  envs: readonly Environment[];
}
const ProductEnvContext = createContext<ProductEnv | null>(null);

export function ProductEnvProvider({ productId, section, envs, urlEnv, children }: {
  productId: string; section: string; envs: readonly Environment[]; urlEnv?: Environment; children: ReactNode;
}) {
  const [env, setState] = useState<Environment>(() => pickEnv(envs, urlEnv ?? stored(productId)));
  const setEnv = (e: Environment) => {
    setState(e);
    store(productId, e);
  };
  // A link or edited URL that names an environment wins (and is remembered).
  useEffect(() => {
    if (urlEnv && envs.includes(urlEnv)) setEnv(urlEnv);
  }, [urlEnv]);
  // Keep the address shareable without adding history entries.
  useEffect(() => {
    const hash = `#/p/${encodeURIComponent(productId)}/${section}?env=${env}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }, [productId, section, env]);
  return <ProductEnvContext.Provider value={{ env, setEnv, envs }}>{children}</ProductEnvContext.Provider>;
}

/** The current product's selected environment (inside a product section). */
export function useProductEnv(): ProductEnv {
  const v = useContext(ProductEnvContext);
  if (!v) throw new Error('useProductEnv outside ProductEnvProvider');
  return v;
}
