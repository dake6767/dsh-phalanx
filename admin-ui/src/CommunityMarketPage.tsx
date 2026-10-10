import { Tabs } from '@heroui/react/tabs';
import { usePlatformLanguage } from './CommunityLanguage';
import CommunityMarketPlugins from './CommunityMarketPlugins';
import CommunityMarketSkills from './CommunityMarketSkills';

export default function CommunityMarketPage() {
  const { t } = usePlatformLanguage();
  return <main className="page-stack p-6"><div className="page-title"><h1>{t('Platform apps')}</h1></div>
    <Tabs variant="secondary"><Tabs.ListContainer><Tabs.List aria-label={t('Platform apps')}><Tabs.Tab id="plugins">{t('Plugins')}<Tabs.Indicator/></Tabs.Tab><Tabs.Tab id="skills">{t('Skills')}<Tabs.Indicator/></Tabs.Tab></Tabs.List></Tabs.ListContainer>
      <Tabs.Panel id="plugins"><CommunityMarketPlugins/></Tabs.Panel><Tabs.Panel id="skills"><CommunityMarketSkills/></Tabs.Panel>
    </Tabs>
  </main>;
}
