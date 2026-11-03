// Console chrome: sidebar (products, the current product's sections, account menu) and the top bar
// (breadcrumb, language, theme). Routes are hash-based: `#/` products, `#/p/<id>/<section>`.
import type { ReactNode } from 'react';
import { PLATFORM_NAME } from './brand.ts';
import { BrandMark } from './brand-mark.tsx';
import { Check, ChevronsUpDown, Languages, LogOut, MailPlus, Monitor, Moon, Package, Sun } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from '@/components/ui/sidebar';
import { defineMessages, useLocale, useT, type Locale } from './i18n.tsx';
import { sectionMessages, visibleSections } from './pages/ProductDetail.tsx';
import { useTheme, type Theme } from './theme.tsx';
import type { ProductSummary } from './types.ts';
import { isOwner, useApp, useLoad } from './ui.tsx';

export const shellMessages = defineMessages({
  zh: {
    console: '控制台',
    platform: '平台',
    products: '产品',
    allProducts: '全部产品',
    invitations: '邀请',
    switchProduct: '切换产品',
    language: '语言',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    signOut: '退出登录',
    roles: '角色',
    role_owner: '平台所有者',
    role_operator: '运维',
    role_product_admin: '产品管理员',
    role_product_developer: '产品开发者',
  },
  en: {
    console: 'Console',
    platform: 'Platform',
    products: 'Products',
    allProducts: 'All products',
    invitations: 'Invitations',
    switchProduct: 'Switch product',
    language: 'Language',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    signOut: 'Sign out',
    roles: 'Roles',
    role_owner: 'Platform owner',
    role_operator: 'Operator',
    role_product_admin: 'Product admin',
    role_product_developer: 'Product developer',
  },
});

/** Platform-level pages outside any product (`#/<page>`). */
export type PlatformPage = 'invitations';

export interface Route {
  productId?: string;
  section?: string;
  platformPage?: PlatformPage;
}

export function Shell({ route, onSignOut, children }: { route: Route; onSignOut: () => void; children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar route={route} onSignOut={onSignOut} />
      <SidebarInset>
        <TopBar route={route} />
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function useProducts() {
  return useLoad((a) => a.get<{ products: ProductSummary[] }>('/products'), 'shell-products');
}

function AppSidebar({ route, onSignOut }: { route: Route; onSignOut: () => void }) {
  const { me } = useApp();
  const t = useT(shellMessages);
  const s = useT(sectionMessages);
  const products = useProducts();
  const current = products.data?.products.find((p) => p.id === route.productId);
  const sections = route.productId ? visibleSections(me, route.productId) : [];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="#/">
                <BrandMark />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">{PLATFORM_NAME}</span>
                  <span className="text-muted-foreground truncate text-xs">{t.console}</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t.platform}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={!route.productId && !route.platformPage} tooltip={t.products}>
                <a href="#/">
                  <Package />
                  <span>{t.products}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {isOwner(me) && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={route.platformPage === 'invitations'} tooltip={t.invitations}>
                  <a href="#/invitations">
                    <MailPlus />
                    <span>{t.invitations}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>

        {route.productId && (
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton className="border" tooltip={t.switchProduct}>
                      <span className="bg-muted flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold uppercase">
                        {(current?.name ?? route.productId).slice(0, 1)}
                      </span>
                      <span className="truncate font-medium">{current?.name ?? route.productId}</span>
                      <ChevronsUpDown className="ml-auto" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56" align="start">
                    <DropdownMenuLabel className="text-muted-foreground text-xs">{t.switchProduct}</DropdownMenuLabel>
                    {products.data?.products.map((p) => (
                      <DropdownMenuItem key={p.id} asChild>
                        <a href={`#/p/${p.id}/${route.section ?? 'settings'}`}>
                          <span className="truncate">{p.name}</span>
                          <span className="text-muted-foreground ml-auto font-mono text-xs">{p.id}</span>
                          {p.id === route.productId && <Check className="size-4" />}
                        </a>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <a href="#/">{t.allProducts}</a>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
              {sections.map((sec) => (
                <SidebarMenuItem key={sec.id}>
                  <SidebarMenuButton asChild isActive={(route.section ?? sections[0]!.id) === sec.id} tooltip={s[sec.id]}>
                    <a href={`#/p/${route.productId}/${sec.id}`}>
                      <sec.icon />
                      <span>{s[sec.id]}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <AccountMenu onSignOut={onSignOut} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const { me } = useApp();
  const t = useT(shellMessages);
  const roles = [...new Set(me.grants.map((g) => g.role))];
  const initials = me.user_id.replace(/^usr_/, '').slice(0, 2).toUpperCase();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{roles.map((r) => t[`role_${r}`]).join(' · ')}</span>
                <span className="text-muted-foreground truncate font-mono text-xs">{me.user_id}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="space-y-1 font-normal">
              <p className="text-muted-foreground text-xs">{t.roles}</p>
              {me.grants.map((g) => (
                <p key={`${g.role}:${g.productId}`} className="text-sm">
                  {t[`role_${g.role}`]}
                  {g.productId && <span className="text-muted-foreground font-mono"> · {g.productId}</span>}
                </p>
              ))}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut />
              {t.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function TopBar({ route }: { route: Route }) {
  const t = useT(shellMessages);
  const s = useT(sectionMessages);
  const section = route.section as keyof typeof s | undefined;
  return (
    <header className="bg-background/80 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {route.platformPage ? (
              <BreadcrumbPage>{t[route.platformPage]}</BreadcrumbPage>
            ) : route.productId ? (
              <BreadcrumbLink href="#/">{t.products}</BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{t.products}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {route.productId && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href={`#/p/${route.productId}`} className="font-mono">{route.productId}</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className="hidden sm:block">
                <BreadcrumbPage>{s[section && section in s ? section : 'settings']}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1">
        <LanguageMenu />
        <ThemeMenu />
      </div>
    </header>
  );
}

function LanguageMenu() {
  const t = useT(shellMessages);
  const { locale, setLocale } = useLocale();
  const options: Array<[Locale, string]> = [['zh', '简体中文'], ['en', 'English']];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t.language}>
          <Languages />
          <span className="hidden sm:inline">{locale === 'zh' ? '中文' : 'EN'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map(([l, label]) => (
          <DropdownMenuItem key={l} onClick={() => setLocale(l)}>
            {label}
            {l === locale && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const t = useT(shellMessages);
  const { theme, setTheme } = useTheme();
  const options: Array<[Theme, string, typeof Sun]> = [['light', t.light, Sun], ['dark', t.dark, Moon], ['system', t.system, Monitor]];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t.theme}>
          <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map(([value, label, Icon]) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon />
            {label}
            {value === theme && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
