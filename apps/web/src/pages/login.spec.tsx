import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginPage } from './login';
describe('administrator sign-in', () => {
  it('submits the administrator password and shows a useful server error', async () => {
    const login = vi
      .fn()
      .mockRejectedValue(new Error('Incorrect administrator password.'));
    render(<LoginPage onLogin={login} />);
    fireEvent.change(screen.getByLabelText('Mật khẩu quản trị'), {
      target: { value: 'example-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Vào không gian làm việc' }),
    );
    await waitFor(() => expect(login).toHaveBeenCalledWith('example-password'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Incorrect administrator password.',
    );
    expect(
      screen.getByRole('button', { name: 'Vào không gian làm việc' }),
    ).not.toBeDisabled();
  });
});
