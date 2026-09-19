const form = document.querySelector('#proxy-form');
const input = document.querySelector('#url');
const error = document.querySelector('#error');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  error.textContent = '';

  try {
    const target = new URL(input.value.trim());

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Use an http:// or https:// URL.');
    }

    window.location.href = `/remote?url=${encodeURIComponent(target.href)}`;
  } catch (reason) {
    error.textContent = reason.message || 'Enter a valid URL.';
  }
});