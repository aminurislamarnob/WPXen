import {
  LayoutDashboard,
  Globe,
  Server,
  Code2,
  Mail,
  Settings,
  Terminal,
  ListTodo,
} from 'lucide-react';

// The app's main screens, grouped. Shared by the main sidebar and the Agents
// activity bar so the two can't drift apart. The last group (Settings) is the
// one the activity bar pins to its bottom edge.
export const NAV_GROUPS = [
  [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'blue' },
    { to: '/sites', icon: Globe, label: 'Sites', color: 'teal' },
    { to: '/agents', icon: Terminal, label: 'Agents', color: 'purple' },
    { to: '/tasks', icon: ListTodo, label: 'Tasks', color: 'orange' },
  ],
  [
    { to: '/services', icon: Server, label: 'Services', color: 'green' },
    { to: '/php', icon: Code2, label: 'PHP', color: 'indigo' },
    { to: '/mail', icon: Mail, label: 'Mail', color: 'red' },
  ],
  [{ to: '/settings', icon: Settings, label: 'Settings', color: 'gray' }],
];
