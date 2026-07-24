// @ts-nocheck
import { graphemes, TerminalInputParser } from './editor.js';
import { withInteractiveScreen } from './terminal.js';
import { createThemeContext } from './theme.js';
import {
  approvalChoices,
  renderSetupFrame,
  setupSelect,
  validateBaseURL,
  validateProviderName,
} from './setup-render.js';
export {
  approvalChoices,
  maskSecret,
  renderSetupFrame,
  renderSetupScreen,
  setupSelect,
  setupWordmark,
  validateBaseURL,
  validateProviderName,
  visibleSetupItems,
} from './setup-render.js';
async function runSetupWizard(options, screen) {
  const input = screen.input;
  const output = screen.output;
  const context =
    options.themeContext ?? createThemeContext({ isTTY: output.isTTY, env: process.env });
  let step = options.confirmReplace ? 'confirm' : 'provider';
  let selected = options.confirmReplace ? 1 : 0;
  let value = '';
  let message = '';
  let busy = false;
  let closed = false;
  let fetchController;
  let provider = options.providers[0];
  let providerName = provider.name;
  let baseURL = provider.baseURL;
  let apiKey;
  let keySource = provider.local ? 'local' : 'not configured';
  let model = '';
  let approval = 'suggest';
  let models = [];
  let buildModels = [];
  let projects = [];
  let projectId = '';
  let buildModel = '';
  let fetchError;
  const draw = () => {
    const width = output.columns ?? 80;
    const height = output.rows ?? 28;
    const screen = (title, extra) =>
      screenOutput.draw(
        renderSetupFrame({
          width,
          height,
          step,
          title,
          message,
          busy,
          themeContext: context,
          ...extra,
        }),
      );
    if (step === 'confirm')
      return screen('Replace active provider settings?', {
        items: [
          { name: 'Continue', description: 'Review and replace active provider settings' },
          { name: 'Cancel', description: 'Leave current settings unchanged' },
        ],
        selected,
      });
    if (step === 'provider')
      return screen('Choose a provider', {
        items: options.providers.map((p) => ({
          name: p.name === '__custom__' ? 'Custom OpenAI-compatible' : p.name,
          description: p.description,
        })),
        selected,
      });
    if (step === 'approval')
      return screen('Choose approval mode', {
        items: approvalChoices.map((p) => ({
          name: p.value,
          description: p.description,
          danger: p.value === 'full-auto',
        })),
        selected,
      });
    if (step === 'model' && models.length)
      return screen(
        provider.name === 'capy'
          ? 'Choose the Capy Captain model'
          : 'Choose a model (or select Manual entry)',
        {
          items: [
            ...models.map((name) => ({ name, description: '' })),
            ...(provider.name === 'capy'
              ? []
              : [{ name: 'Manual entry', description: 'Enter any model ID' }]),
          ],
          selected,
        },
      );
    if (step === 'build-model' && buildModels.length)
      return screen('Choose the Capy Build model', {
        items: [
          ...buildModels.map((name) => ({
            name,
            description: name === model ? 'same model as Captain' : '',
          })),
        ],
        selected,
      });
    if (step === 'project' && projects.length)
      return screen('Choose a Capy project (remote repositories/VMs)', {
        items: [
          ...projects.map((project) => ({
            name: project.name,
            description: `${project.id}${project.description ? ` · ${project.description}` : ''}`,
          })),
        ],
        selected,
      });
    if (step === 'review')
      return screen('Review setup', {
        review: [
          `Provider: ${providerName}`,
          `Model: ${model}${provider.name === 'capy' ? ' (Captain)' : ''}`,
          ...(buildModel ? [`Build model: ${buildModel}`] : []),
          ...(projectId ? [`Capy project: ${projectId} (remote connected repositories)`] : []),
          `Base URL: ${baseURL ?? 'preset'}`,
          `Key: ${keySource === 'local' ? 'not configured' : keySource}`,
          `Approval: ${approval}`,
          `Config: ${options.configPath}`,
          ...(apiKey ? ['A key will be stored locally (0600).'] : []),
        ],
      });
    const labels = {
      name: 'Name your OpenAI-compatible provider',
      url: 'Enter its base URL (usually ending in /v1)',
      key: provider.remote
        ? `${provider.env ?? 'API'} key (required to fetch projects and models; input is hidden)`
        : provider.env
          ? `${provider.env} API key (optional; input is hidden)`
          : 'API key (optional; input is hidden)',
      model: 'Enter a model ID',
      'build-model': 'Enter a Capy Build model ID',
      project: 'Enter a Capy project ID',
    };
    return screen(labels[step], { value, secret: step === 'key' });
  };
  const fetchWithTimeout = async (
    request,
    fallback,
    timeoutMs = provider.remote ? 15000 : 4000,
  ) => {
    if (!request) return fallback;
    fetchController = new AbortController();
    let timeout;
    let didTimeout = false;
    try {
      const pending = request().catch((error) => {
        if (didTimeout) return fallback;
        throw error;
      });
      const timedOut = new Promise((resolve) => {
        timeout = setTimeout(() => {
          didTimeout = true;
          fetchController?.abort();
          resolve(fallback);
        }, timeoutMs);
      });
      const result = await Promise.race([pending, timedOut]);
      if (didTimeout) fetchError = `request timed out after ${timeoutMs}ms`;
      return result;
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      return fallback;
    } finally {
      if (timeout) clearTimeout(timeout);
      fetchController = undefined;
    }
  };
  const advance = async () => {
    message = '';
    if (step === 'confirm') {
      if (selected !== 0) return false;
      step = 'provider';
      selected = 0;
      return true;
    }
    if (step === 'provider') {
      provider = options.providers[selected];
      providerName = provider.name;
      baseURL = provider.baseURL;
      keySource = provider.local ? 'local' : (options.keySource?.(provider) ?? 'not configured');
      step = provider.name === '__custom__' ? 'name' : provider.local ? 'model' : 'key';
      value = '';
      return true;
    }
    if (step === 'name') {
      const err = validateProviderName(value);
      if (err) {
        message = err;
        return true;
      }
      providerName = value;
      value = '';
      step = 'url';
      return true;
    }
    if (step === 'url') {
      const err = validateBaseURL(value);
      if (err) {
        message = err;
        return true;
      }
      baseURL = value;
      value = '';
      step = 'key';
      return true;
    }
    if (step === 'key') {
      if (value) {
        apiKey = value;
        keySource = 'saved';
      }
      value = '';
      fetchError = undefined;
      busy = true;
      draw();
      if (provider.name === 'capy')
        projects = await fetchWithTimeout(
          options.fetchProjects
            ? () =>
                options.fetchProjects({
                  provider: providerName,
                  baseURL,
                  apiKey,
                  signal: fetchController.signal,
                })
            : undefined,
          [],
        );
      models = await fetchWithTimeout(
        options.fetchModels
          ? () =>
              options.fetchModels({
                provider: providerName,
                baseURL,
                apiKey,
                local: provider.local,
                signal: fetchController.signal,
              })
          : undefined,
        [],
      );
      if (provider.name === 'capy')
        buildModels = await fetchWithTimeout(
          options.fetchBuildModels
            ? () =>
                options.fetchBuildModels({
                  provider: providerName,
                  baseURL,
                  apiKey,
                  local: provider.local,
                  signal: fetchController.signal,
                })
            : undefined,
          [],
        );
      if (closed) return false;
      busy = false;
      const problems = [];
      if (!models.length) {
        problems.push(
          fetchError
            ? `Models: ${fetchError}`
            : provider.remote
              ? 'Models: API returned none — check your key.'
              : 'Models: endpoint returned none.',
        );
      }
      if (provider.name === 'capy' && !buildModels.length) {
        problems.push(
          fetchError
            ? `Build models: ${fetchError}`
            : 'Build models: API returned none; check your key.',
        );
      }
      if (provider.name === 'capy' && !projects.length) {
        problems.push(
          fetchError ? `Projects: ${fetchError}` : 'Projects: API returned none — check your key.',
        );
      }
      if (problems.length) {
        message = problems.join(' · ');
        if (provider.name === 'capy') {
          step = 'key';
          selected = 0;
          return true;
        }
      }
      step = provider.name === 'capy' ? 'project' : 'model';
      selected = 0;
      return true;
    }
    if (step === 'model') {
      if (models.length && selected < models.length) {
        model = models[selected];
        selected = 0;
        step = provider.name === 'capy' ? 'build-model' : 'approval';
      } else {
        value = '';
        models = [];
      }
      return true;
    }
    if (step === 'project') {
      if (projects.length && selected < projects.length) {
        projectId = projects[selected].id;
        selected = 0;
        step = 'model';
      } else {
        value = '';
        projects = [];
      }
      return true;
    }
    if (step === 'build-model') {
      if (buildModels.length && selected < buildModels.length) {
        buildModel = buildModels[selected];
        selected = 0;
        step = 'approval';
      } else {
        value = '';
        buildModels = [];
      }
      return true;
    }
    if (step === 'approval') {
      approval = approvalChoices[selected].value;
      step = 'review';
      return true;
    }
    return true;
  };
  const back = () => {
    message = '';
    if (step === 'confirm' || step === 'provider') return false;
    if (step === 'name') step = 'provider';
    else if (step === 'url') step = 'name';
    else if (step === 'key') step = provider.name === '__custom__' ? 'url' : 'provider';
    else if (step === 'model')
      step = provider.name === 'capy' ? 'project' : provider.local ? 'provider' : 'key';
    else if (step === 'build-model') step = 'model';
    else if (step === 'project') step = 'key';
    else if (step === 'approval') step = provider.name === 'capy' ? 'build-model' : 'model';
    else step = 'approval';
    selected = 0;
    value = '';
    return true;
  };
  const screenOutput = screen;
  const onResize = () => draw();
  output.on('resize', onResize);
  let dataListener;
  let streamFinish;
  let escapeTimer;
  const parser = new TerminalInputParser();
  try {
    draw();
    return await new Promise((resolve) => {
      const finish = (result) => {
        if (closed) return;
        closed = true;
        fetchController?.abort();
        resolve(result);
      };
      streamFinish = () => finish();
      const handleEvent = (event) => {
        if (event.type === 'key' && event.key === 'interrupt') return finish();
        if (busy) return;
        if (event.type === 'key' && event.key === 'escape') {
          if (!back()) finish();
          else draw();
          return;
        }
        if (
          step === 'review' &&
          event.type === 'key' &&
          (event.key === 'enter' || event.key === 'newline' || event.key === 'queue')
        ) {
          if (provider.remote && provider.name === 'capy' && !projectId.trim()) {
            message = 'A Capy project ID is required. Going back to project selection…';
            step = 'project';
            selected = 0;
            draw();
            return;
          }
          return finish({
            provider: providerName,
            baseURL,
            model,
            approval,
            apiKey,
            keySource,
            projectId: projectId || undefined,
            buildModel: buildModel || undefined,
          });
        }
        const listLength =
          step === 'confirm'
            ? 2
            : step === 'provider'
              ? options.providers.length
              : step === 'approval'
                ? approvalChoices.length
                : step === 'model' && models.length
                  ? models.length + (provider.name === 'capy' ? 0 : 1)
                  : step === 'build-model' && buildModels.length
                    ? buildModels.length
                    : step === 'project' && projects.length
                      ? projects.length
                      : 0;
        const listDelta =
          event.type === 'key' && event.key === 'up'
            ? -1
            : event.type === 'key' && event.key === 'down'
              ? 1
              : event.type === 'text' && event.text === 'k'
                ? -1
                : event.type === 'text' && event.text === 'j'
                  ? 1
                  : 0;
        if (listLength && listDelta) {
          selected = setupSelect(selected, listDelta, listLength);
          draw();
          return;
        }
        if (
          event.type === 'key' &&
          (event.key === 'enter' || event.key === 'newline' || event.key === 'queue')
        ) {
          if (step === 'model' && !models.length) {
            if (!value.trim()) {
              message = 'Enter a model ID.';
              draw();
              return;
            }
            model = value.trim();
            value = '';
            selected = 0;
            step = provider.name === 'capy' ? 'build-model' : 'approval';
            draw();
            return;
          }
          if (step === 'build-model' && !buildModels.length) {
            if (!value.trim()) {
              message = 'Enter a Build model ID.';
              draw();
              return;
            }
            buildModel = value.trim();
            value = '';
            selected = 0;
            step = 'approval';
            draw();
            return;
          }
          if (step === 'project' && !projects.length) {
            if (!value.trim()) {
              message = 'Enter a project ID.';
              draw();
              return;
            }
            projectId = value.trim();
            value = '';
            selected = 0;
            step = 'model';
            draw();
            return;
          }
          busy = true;
          void advance().then((keep) => {
            if (!closed) {
              busy = false;
              if (keep === false) finish();
              else draw();
            }
          });
          draw();
          return;
        }
        if (!listLength) {
          if (event.type === 'key' && event.key === 'backspace')
            value = graphemes(value).slice(0, -1).join('');
          else if (event.type === 'text') value += event.text;
          else if (event.type === 'paste') value += event.text.replace(/[\r\n]/g, '');
          draw();
        }
      };
      const onData = (chunk) => {
        if (escapeTimer) clearTimeout(escapeTimer);
        for (const event of parser.feed(chunk)) handleEvent(event);
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          for (const event of parser.flushEscape()) handleEvent(event);
        }, 25);
      };
      dataListener = onData;
      input.on('data', onData);
      input.once('close', streamFinish);
      input.once('error', streamFinish);
      output.once('close', streamFinish);
      output.once('error', streamFinish);
    });
  } finally {
    if (escapeTimer) clearTimeout(escapeTimer);
    if (dataListener) input.removeListener('data', dataListener);
    if (streamFinish) {
      input.removeListener('close', streamFinish);
      input.removeListener('error', streamFinish);
      output.removeListener('close', streamFinish);
      output.removeListener('error', streamFinish);
    }
    output.removeListener('resize', onResize);
  }
}
export async function setupWizard(options) {
  if (options.screen) return await runSetupWizard(options, options.screen);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      'interactive setup requires a TTY; set KYOKAO_PROVIDER and provider settings, or run `kyokao config setup` in a terminal',
    );
  return await withInteractiveScreen({ input, output }, async (screen) => {
    return await runSetupWizard(options, screen);
  });
}
