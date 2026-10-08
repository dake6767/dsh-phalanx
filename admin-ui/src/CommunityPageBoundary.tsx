import { usePlatformLanguage } from './CommunityLanguage';
import { Component, type ReactNode } from 'react';
import CommunityMessage from './CommunityMessage';
/** A failed page chunk still leaves navigation and the independent platform entries usable. */
class PageBoundary extends Component<{ children: ReactNode; failure: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? this.props.failure : this.props.children;
  }
}

export default function CommunityPageBoundary({ children }: { children: ReactNode }) {
 const { t } = usePlatformLanguage();
 return <PageBoundary failure={<CommunityMessage role="alert" status="danger" title={t('Unable to load this management page.')}><a href={location.pathname}>{t('Reload page')}</a> · <a href="/recovery">{t('Open instance recovery')}</a></CommunityMessage>}>{children}</PageBoundary>;
}
