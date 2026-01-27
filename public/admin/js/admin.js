// Confirmation modal for destructive actions
document.addEventListener('DOMContentLoaded', () => {
  const confirmModal = document.getElementById('confirmModal');
  if (!confirmModal) return;

  const modal = new bootstrap.Modal(confirmModal);
  const confirmBtn = document.getElementById('confirmBtn');
  const confirmMessage = document.getElementById('confirmMessage');

  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const message = el.getAttribute('data-confirm') || 'Are you sure?';
      confirmMessage.textContent = message;

      // For form submit buttons
      const form = el.closest('form');
      if (form) {
        confirmBtn.onclick = () => {
          modal.hide();
          form.submit();
        };
      }

      // For links
      if (el.tagName === 'A') {
        confirmBtn.onclick = () => {
          modal.hide();
          window.location.href = el.href;
        };
      }

      modal.show();
    });
  });

  // Auto-dismiss alerts after 5 seconds
  document.querySelectorAll('.alert-dismissible').forEach((alert) => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert);
      if (bsAlert) bsAlert.close();
    }, 5000);
  });
});
