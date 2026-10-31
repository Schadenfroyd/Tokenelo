import {afterAll} from 'vitest';
import {installBootstrapObserver} from './cloud-bootstrap-observer.mjs';

const observer=installBootstrapObserver();
afterAll(()=>observer.restore());
