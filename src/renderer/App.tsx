import { useEffect, useRef, useState } from 'react';

import UpdateCheckFeedback from '@/components/UpdateCheckFeedback';
import UpdateNotification from '@/components/UpdateNotification';
import UpdateReadyBanner from '@/components/UpdateReadyBanner';
import Chat from '@/pages/Chat';
import Settings from '@/pages/Settings';

export default function App() {
  const [currentView, setCurrentView] = useState<'home' | 'settings'>('home');
  const currentViewRef = useRef<'home' | 'settings'>('home');

  useEffect(() => {
    // Update ref whenever currentView changes
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    // Listen for navigation events from main process
    const unsubscribeNavigate = window.electron.onNavigate((view: string) => {
      // If navigating to settings and already on settings, toggle back to home
      if (view === 'settings' && currentViewRef.current === 'settings') {
        setCurrentView('home');
      } else {
        setCurrentView(view as 'home' | 'settings');
      }
    });

    return () => {
      unsubscribeNavigate();
    };
  }, []);

  return (
    <>
      <UpdateCheckFeedback />
      <UpdateNotification />
      <UpdateReadyBanner />
      <div className={currentView === 'settings' ? 'block' : 'hidden'}>
        <Settings onBack={() => setCurrentView('home')} />
      </div>
      <div className={currentView === 'home' ? 'block' : 'hidden'}>
        <Chat />
      </div>
    </>
  );
}
