import './styles.css';
import { renderEdit } from './ui/edit';
import { renderHome } from './ui/home';
import { renderProcess } from './ui/process';
import { renderRecord } from './ui/record';
import { startRouter } from './ui/router';
import { renderSettings } from './ui/settings';

startRouter((root, route) => {
  switch (route.name) {
    case 'home':
      return renderHome(root);
    case 'settings':
      return renderSettings(root);
    case 'edit':
      return renderEdit(root, route.id);
    case 'record':
      return renderRecord(root, route.autoStart);
    case 'process':
      return renderProcess(root, route);
  }
});
