import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App.tsx';
import { applyBrand } from './brand.ts';
import { I18nProvider } from './i18n.tsx';
import { ThemeProvider } from './theme.tsx';
import { ConfirmProvider } from './ui.tsx';
import './index.css';

applyBrand();

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider>
      <TooltipProvider>
        <ConfirmProvider>
          <App />
          <Toaster richColors position="top-right" />
        </ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </ThemeProvider>,
);
